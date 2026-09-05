import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ensureDatabase, DATABASE_SCHEMA_VERSION } from '../../db/bootstrap.ts';

const bindings: { DB?: D1Database } = {};
Object.assign(globalThis, { __publicStorageTestEnv: bindings });
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) { if(s === 'cloudflare:workers') return {shortCircuit:true,url:'data:text/javascript,export const env = globalThis.__publicStorageTestEnv;'}; return n(s,c); }`)}`, import.meta.url);
const storage = await import('../../lib/pipeline/storage.ts');
const { defineListingStub, defineListingDetail } = await import('../../lib/domain/listings.ts');

class Statement {
  values: SQLInputValue[] = [];
  constructor(readonly db: DatabaseSync, readonly sql: string) {}
  bind(...values: SQLInputValue[]) { this.values = values; return this; }
  execute() {
    const query=this.db.prepare(this.sql);
    if (/^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(this.sql)) return { success:true, results:query.all(...this.values), meta:{} };
    return { success:true, results:[], meta:{ changes:Number(query.run(...this.values).changes) } };
  }
  async run() { return this.execute(); }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return {success:true,results:this.db.prepare(this.sql).all(...this.values),meta:{}}; }
}
async function database() {
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const binding={
    prepare(sql:string) { return new Statement(db,sql); },
    async batch(statements: Statement[]) {
      db.exec('BEGIN IMMEDIATE');
      try { const result=statements.map(s=>s.execute()); db.exec('COMMIT'); return result; }
      catch(error) { db.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  bindings.DB=binding;
  assert.deepEqual(await ensureDatabase(binding),{version:DATABASE_SCHEMA_VERSION,initialized:true});
  return {db,binding};
}
const at='2026-01-01T00:00:00.000Z';
function stub(id:string) { return defineListingStub({sourceId:'fixture',sourceListingId:id,sourceUrl:`https://inventory.example.test/items/${id}`,title:`Item ${id}`,discoveredAt:at,contentHash:'fnv1a64:0123456789abcdef',category:null,lotNumber:null,thumbnailUrl:null}); }
function seed(db:DatabaseSync) {
  db.prepare('INSERT INTO auction_sources(id,display_name,base_url) VALUES (?,?,?)').run('fixture','Fixture inventory','https://inventory.example.test');
  for(const id of ['run1','run2']) db.prepare("INSERT INTO discovery_runs(id,trigger,status,origin_postal_code) VALUES (?, 'manual','running','10001')").run(id);
}
test('fresh schema is repeatable and contains no source-specific storage',async()=>{
  const {db,binding}=await database();
  assert.equal((await ensureDatabase(binding)).initialized,false);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const objects=db.prepare('SELECT name FROM sqlite_master').all().map(r=>String(r.name));
  assert.equal(objects.some(name=>/gsa|shared_listing_alias|listing_shared_alias|source_frontier_/.test(name)),false);
  const { getTableConfig } = await import('drizzle-orm/sqlite-core');
  const { isTable } = await import('drizzle-orm');
  const schema=await import('../../db/schema.ts');
  for(const table of Object.values(schema).filter(isTable)) {
    assert.ok(objects.includes(getTableConfig(table as never).name),`missing ${getTableConfig(table as never).name}`);
  }
  const sqlDatabase=new DatabaseSync(':memory:');
  sqlDatabase.exec(readFileSync(new URL('../../drizzle/0000_public_schema.sql',import.meta.url),'utf8'));
  const schemaQuery="SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
  assert.deepEqual(sqlDatabase.prepare(schemaQuery).all(),db.prepare(schemaQuery).all());
  sqlDatabase.close();
  db.close();
});
test('generic recovery ordering prioritizes fresh local work without starving older work',async()=>{
  const { NON_INLINE_RECOVERY_ORDER_SQL, NON_INLINE_RECOVERY_FAIRNESS_ORDER_SQL }=await import('../../lib/pipeline/recovery.ts');
  const db=new DatabaseSync(':memory:');
  const candidates=`WITH candidates(id,current_inventory_new,origin_priority,recovery_state,recovery_last_attempted_at,discovered_at) AS (VALUES
    ('old-retry',0,0,'retryable','2026-01-01','2025-01-01'),
    ('recent-local',1,1,NULL,NULL,'2026-01-02'),
    ('old-untouched',0,0,NULL,NULL,'2025-01-01')
  ) SELECT id FROM candidates ORDER BY `;
  assert.deepEqual(db.prepare(candidates+NON_INLINE_RECOVERY_ORDER_SQL).all().map(row=>row.id),['recent-local','old-untouched','old-retry']);
  assert.deepEqual(db.prepare(candidates+NON_INLINE_RECOVERY_FAIRNESS_ORDER_SQL).all().map(row=>row.id),['old-untouched','recent-local','old-retry']);
  db.close();
});
test('complete inventory publishes atomically and checkpoints resume by exact plan',async()=>{
  const {db}=await database();seed(db);
  const first=await storage.ensureListingStub('run1',stub('a'));
  const second=await storage.ensureListingStub('run1',stub('b'));
  const plan={sourceId:'fixture',fingerprint:'inventory-v1',expectedListings:2,pages:[{key:'page-a',inventoryMember:true,reviewCandidate:true},{key:'page-b',inventoryMember:true,reviewCandidate:true}]};
  const traversal=await storage.prepareSourceInventoryTraversal(plan);
  await storage.checkpointSourceInventoryTraversalPage({traversalId:traversal.traversalId,sourceId:'fixture',pageKey:'page-a',listingIds:[first.id],observedAt:at});
  const resumed=await storage.prepareSourceInventoryTraversal(plan);
  assert.equal(resumed.traversalId,traversal.traversalId);
  assert.deepEqual(resumed.completedPageKeys,['page-a']);
  await assert.rejects(storage.publishSourceInventoryTraversal({traversalId:traversal.traversalId,runId:'run1',sourceId:'fixture',originCacheKey:'test-origin'}),/incomplete pages/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM source_current_listings').get()!.n,0);
  await storage.checkpointSourceInventoryTraversalPage({traversalId:traversal.traversalId,sourceId:'fixture',pageKey:'page-b',listingIds:[second.id],observedAt:at});
  const result=await storage.publishSourceInventoryTraversal({traversalId:traversal.traversalId,runId:'run1',sourceId:'fixture',originCacheKey:'test-origin'});
  assert.equal(result.publishedCount,2);
  assert.equal(result.candidateCount,2);
  assert.equal(result.publicationTransition?.resultingHead.inventoryRunId,'run1');
  assert.equal((await storage.readSourceInventoryPublicationHead('fixture'))?.listingCount,2);
  assert.equal(db.prepare('SELECT collection_counts_json FROM source_inventory_publications WHERE source_id=? AND inventory_run_id=?').get('fixture','run1')!.collection_counts_json,'[]');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  db.close();
});
test('complete-current pages publish an empty total and reject an incomplete total without replacing the prior head',async()=>{
  const {db}=await database();seed(db);
  const empty=await storage.prepareSourceInventoryTraversal({sourceId:'fixture',fingerprint:'empty-v1',expectedListings:0,pages:[{key:'empty-result',inventoryMember:false,reviewCandidate:false}]});
  await storage.checkpointSourceInventoryTraversalPage({traversalId:empty.traversalId,sourceId:'fixture',pageKey:'empty-result',listingIds:[],observedAt:at});
  const published=await storage.publishSourceInventoryTraversal({traversalId:empty.traversalId,runId:'run1',sourceId:'fixture',originCacheKey:'test-origin'});
  assert.equal(published.publishedCount,0);
  const listing=await storage.ensureListingStub('run2',stub('a'));
  const incomplete=await storage.prepareSourceInventoryTraversal({sourceId:'fixture',fingerprint:'incomplete-v1',expectedListings:2,pages:[{key:'ordinary-page',inventoryMember:true,reviewCandidate:true}]});
  await storage.checkpointSourceInventoryTraversalPage({traversalId:incomplete.traversalId,sourceId:'fixture',pageKey:'ordinary-page',listingIds:[listing.id],observedAt:at});
  await assert.rejects(storage.publishSourceInventoryTraversal({traversalId:incomplete.traversalId,runId:'run2',sourceId:'fixture',originCacheKey:'test-origin'}),/expected 2/);
  assert.equal((await storage.readSourceInventoryPublicationHead('fixture'))?.inventoryRunId,'run1');
  assert.equal(db.prepare('SELECT count(*) AS n FROM source_current_listings').get()!.n,0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  db.close();
});
test('direct current-inventory replacement publishes source-owned review candidates and an explicit empty successor',async()=>{
  const {db}=await database();seed(db);
  const listing=await storage.ensureListingStub('run1',stub('a'));
  const published=await storage.replaceSourceCurrentInventory({sourceId:'fixture',runId:'run1'});
  assert.equal(published.resultingHead.listingCount,1);
  assert.equal(await storage.readStoredListingDetail(listing.id),null,'publication must not synthesize immutable detail from a stub');
  assert.deepEqual(db.prepare('SELECT listing_id,review_candidate FROM source_current_listings').all().map(row=>({...row})),[{listing_id:listing.id,review_candidate:1}]);
  const empty=await storage.replaceSourceCurrentInventory({sourceId:'fixture',runId:'run2'});
  assert.equal(empty.priorHead?.inventoryRunId,'run1');
  assert.equal(empty.resultingHead.listingCount,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM source_current_listings').get()!.n,0);
  assert.equal(await storage.findSeenListing('fixture','a'),listing.id);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  db.close();
});
test('first-seen stub and complete detail remain immutable on repeat acquisition',async()=>{
  const {db}=await database();seed(db);
  const first=await storage.ensureListingStub('run1',stub('a'));
  await storage.ensureListingStub('run2',defineListingStub({...stub('a'),title:'Changed title'}));
  assert.equal(db.prepare('SELECT title FROM listing_stubs WHERE id=?').get(first.id)!.title,'Item a');
  const detail=defineListingDetail({...stub('a'),rawDescription:'Original description',cleanDescription:'Original description',scrapedAt:at,auctionEndsAt:null,seller:null,priceAtScrape:{amountMinor:null,currency:null,displayText:null},images:[]});
  assert.equal((await storage.ensureListingDetail(first.id,detail)).inserted,true);
  await storage.ensureListingDetailObservation(first.id,detail);
  assert.equal((await storage.ensureListingDetail(first.id,detail)).inserted,false);
  assert.equal((await storage.readStoredListingDetail(first.id))?.cleanDescription,'Original description');
  assert.equal(await storage.findSeenListing('fixture','a'),first.id);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  db.close();
});
test('recovery reads and generation reconciliation work on the fresh public schema',async()=>{
  const {db,binding}=await database();seed(db);
  const scope={sourceId:'fixture',originCacheKey:'test-origin',routeProviderName:'test-provider'};
  assert.deepEqual(await storage.readPendingNonInlineGeographicPrefilterListings(scope),[]);
  assert.deepEqual(await storage.readRetryableUnknownRouteRepairListings(scope),[]);
  assert.deepEqual(await storage.readMissingSourceImageEvidenceRepairListings(scope),[]);
  assert.deepEqual(await storage.readPendingNonInlineRecoveryListings({...scope,candidateLimit:1,imageLimit:0,includeFailedImages:false}),[]);
  assert.equal(await storage.pruneRecoveredPipelineRetryStatuses(scope),0);
  const {reconcileCanonicalPipelineGenerations}=await import('../../lib/pipeline/generation-reconcile.ts');
  await reconcileCanonicalPipelineGenerations({database:binding,contracts:{enrichmentTargetIdentity:'fixture-enrichment',preferenceContractIdentity:'fixture-preference',presentationPolicyIdentity:'fixture-presentation'}});
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  db.close();
});

test('pending preparation selects inline detail and missing observations without granting detail requests',async()=>{
  const {db}=await database();seed(db);
  const ids:string[]=[];
  for (const id of ['inline','observation','missing']) {
    const listingStub=defineListingStub({...stub(id),visibleLocation:{postalCode:'90210',countryCode:'US',evidenceSource:'visible_listing'}});
    const listing=await storage.ensureListingStub('run1',listingStub); ids.push(listing.id);
    if(id!=='missing') {
      const detail=defineListingDetail({...listingStub,rawDescription:'Captured detail',cleanDescription:'Captured detail',scrapedAt:at,auctionEndsAt:null,seller:null,priceAtScrape:{amountMinor:null,currency:null,displayText:null},images:[]});
      await storage.ensureListingDetail(listing.id,detail);
      if(id==='inline') await storage.ensureListingDetailObservation(listing.id,detail);
    }
  }
  await storage.replaceSourceCurrentInventory({sourceId:'fixture',runId:'run1'});
  const scope={sourceId:'fixture',originCacheKey:'test-origin',routeProviderName:'test-provider',candidateLimit:10,imageLimit:0,includeFailedImages:false};
  const local=await storage.readPendingNonInlineRecoveryListings({...scope,allowListingDetailRequests:false});
  assert.deepEqual(local.map(row=>row.listingId).sort(),ids.slice(0,2).sort());
  const approved=await storage.readPendingNonInlineRecoveryListings({...scope,allowListingDetailRequests:true});
  assert.deepEqual(approved.map(row=>row.listingId).sort(),ids.sort());
  db.close();
});

test('exact pending preparation skips a completed page, finishes image evidence, and respects retry and terminal boundaries',async()=>{
  process.env.ORIGIN_POSTAL_CODE='90210';
  process.env.ORIGIN_COUNTRY='US';
  const {db}=await database();seed(db);
  const {createPickupRouteAssessor}=await import('../../lib/pipeline/route.ts');
  const {readActiveRouteScope}=await import('../../lib/routing/active-scope.ts');
  const active=await readActiveRouteScope();
  const assessor=await createPickupRouteAssessor(active);
  const pendingIds:string[]=[];
  for(const id of [...Array.from({length:251},(_,i)=>`complete-${String(i).padStart(3,'0')}`),
    'z-absence','z-deferred','z-failed','z-pending','z-reviewed','z-stale','z-terminal']) {
    const listingStub=defineListingStub({...stub(id),visibleLocation:{postalCode:'90210',countryCode:'US',evidenceSource:'visible_listing'}});
    const listing=await storage.ensureListingStub('run1',listingStub);
    const hasImage=['z-deferred','z-failed','z-pending'].includes(id);
    const detail=defineListingDetail({...listingStub,rawDescription:'Captured detail',cleanDescription:'Captured detail',scrapedAt:at,auctionEndsAt:null,seller:null,priceAtScrape:{amountMinor:null,currency:null,displayText:null},images:hasImage?[{sourceUrl:`https://inventory.example.test/${id}.jpg`}]:[]});
    await storage.ensureListingDetail(listing.id,detail);
    await storage.ensureListingDetailObservation(listing.id,detail);
    if(id!=='z-stale') {
      const {destination,route}=await assessor.assess(listingStub.visibleLocation!,listing.id);
      await assessor.persistForListing(listing.id,destination,route);
    }
    if(id.startsWith('complete')) await storage.recordMissingSourceImageEvidenceAbsence({listingId:listing.id,originCacheKey:active.originCacheKey});
    if(id==='z-failed') {
      db.prepare("UPDATE listing_images SET download_status='failed' WHERE listing_id=?").run(listing.id);
      await storage.recordUnavailableSourceImageEvidence({listingId:listing.id});
    }
    if(id==='z-deferred') db.prepare("UPDATE listing_images SET download_status='deferred' WHERE listing_id=?").run(listing.id);
    if(id==='z-reviewed') db.prepare("INSERT INTO listing_votes(listing_id,value) VALUES (?,'interested')").run(listing.id);
    if(id==='z-terminal') await storage.recordNonInlineRecoveryOutcome({listingId:listing.id,originCacheKey:active.originCacheKey,state:'terminal',stage:'detail',errorCode:'listing_ended'});
    if(['z-absence','z-deferred','z-pending','z-stale'].includes(id)) pendingIds.push(listing.id);
  }
  await storage.replaceSourceCurrentInventory({sourceId:'fixture',runId:'run1'});
  const scope={sourceId:'fixture',originCacheKey:active.originCacheKey,routeProviderName:active.providerName,candidateLimit:1,imageLimit:0,includeFailedImages:false,allowListingDetailRequests:false};
  assert.deepEqual((await storage.readPendingNonInlineRecoveryListings(scope)).map(row=>row.listingId),['fixture:z-absence']);
  assert.deepEqual((await storage.readPendingNonInlineRecoveryListings({...scope,candidateLimit:10})).map(row=>row.listingId).sort(),pendingIds.sort());
  assert.deepEqual((await storage.readPendingNonInlineRecoveryListings({...scope,candidateLimit:10,includeFailedImages:true})).map(row=>row.listingId).sort(),[...pendingIds,'fixture:z-failed'].sort());
  assert.deepEqual((await storage.readPendingNonInlineRecoveryListings({...scope,candidateLimit:0,imageLimit:2})).map(row=>row.listingId),['fixture:z-absence','fixture:z-deferred']);
  assert.deepEqual((await storage.readPendingNonInlineRecoveryListings({...scope,excludedListingIds:pendingIds,candidateLimit:10})),[]);
  await storage.recordMissingSourceImageEvidenceAbsence({listingId:'fixture:z-absence',originCacheKey:active.originCacheKey});
  assert.equal((await storage.readPendingNonInlineRecoveryListings({...scope,candidateLimit:10})).some(row=>row.listingId==='fixture:z-absence'),false);
  db.prepare("UPDATE source_current_listings SET inventory_run_id='run2' WHERE listing_id='fixture:z-pending'").run();
  assert.equal((await storage.readPendingNonInlineRecoveryListings({...scope,candidateLimit:10})).some(row=>row.listingId==='fixture:z-pending'),false);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  db.close();
});







