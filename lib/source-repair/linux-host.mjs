import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";

const mode = process.argv[2];
const configuration = JSON.parse(await readFile(process.argv[3], "utf8"));
if (!['canary', 'fixtures', 'replay', 'lifetime_fixture'].includes(mode) || configuration.schemaVersion !== 'source-repair-linux-host-v1' ||
  !/^\/mnt\/[a-z]\//u.test(configuration.copy) || !/^\/mnt\/[a-z]\//u.test(configuration.node) ||
  configuration.copy.includes('/../') || configuration.node.includes('/../') ||
  !Array.isArray(configuration.tests) || configuration.tests.length < 1 || configuration.tests.length > 64 ||
  configuration.tests.some(name => !/^tests\/source-repair-target\/t[0-9]{2}\.test\.mjs$/u.test(name)) ||
  configuration.timeoutMs !== 70000 || configuration.maximumBytes !== 262144) throw new Error('linux_host_contract_invalid');

const base = ['--unshare-all', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
  '--proc', '/proc', '--dev', '/dev', '--new-session', '--die-with-parent', '--clearenv', '--cap-drop', 'ALL',
  '--ro-bind', configuration.copy, '/sandbox', '--ro-bind', configuration.node, '/node', '--size', '16777216', '--tmpfs', '/tmp',
  '--setenv', 'PATH', '/node/bin:/usr/bin', '--setenv', 'TMPDIR', '/tmp', '--chdir', '/sandbox', '--',
  '/usr/bin/prlimit', '--nproc=64', '--cpu=30', '--core=0', '--nofile=128', '--fsize=16777216', '--', '/node/bin/node', '--max-old-space-size=224', '--max-semi-space-size=8'];
// Inherited per-process limits; NPROC counts this real user's processes/threads.
// This profile does not claim an aggregate RSS/cgroup memory ceiling.
let listener; let acceptedConnections = 0; let networkControl = false; let child; let stopped = false; let childFinished = false;
async function descendants(pid) {
  const text = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '');
  const children = text.trim().split(/\s+/u).filter(Boolean).map(Number);
  return [...children, ...(await Promise.all(children.map(descendants))).flat()];
}
const stop = () => {
  stopped = true;
  if (child?.pid && !childFinished) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
};
process.stdin.on('end', stop); process.stdin.on('error', stop); process.stdin.on('close', stop); process.stdin.resume();
process.once('SIGTERM', stop); process.once('SIGINT', stop);
try {
  if (mode === 'canary') {
    listener = createServer(socket => { acceptedConnections++; socket.destroy(); });
    await new Promise((okay, fail) => { listener.once('error', fail); listener.listen(0, '127.0.0.1', okay); });
    const address = listener.address();
    await new Promise((okay, fail) => {
      const socket = connect(address.port, '127.0.0.1'); socket.once('error', fail);
      socket.once('connect', () => { socket.destroy(); }); socket.once('close', () => okay());
    });
    networkControl = true; acceptedConnections = 0;
    const canary = JSON.parse(await readFile(configuration.copy + '/canary.json', 'utf8'));
    canary.port = address.port;
    await writeFile(configuration.copy + '/canary.json', JSON.stringify(canary));
  }
  const command = mode === 'canary' ? ['canary.mjs'] : mode === 'fixtures' ? ['--test', '--test-concurrency=1', '--test-reporter=spec', ...configuration.tests]
    : mode === 'replay' ? ['tests/source-repair-target/replay.mjs'] : ['lifetime-fixture.mjs'];
  if (stopped) throw new Error('linux_host_control_closed');
  child = spawn('/usr/bin/bwrap', [...base, ...command], { detached: true, env: { PATH: '/usr/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (mode === 'lifetime_fixture') process.stdout.write(JSON.stringify({ ownedHostPid: process.pid, ownedSandboxPid: child.pid }) + '\n');
  let stdout = ''; let bytes = 0; let limited = false;
  const timer = setTimeout(stop, configuration.timeoutMs);
  const consume = async (chunk, stderr) => {
    bytes += chunk.length;
    if (bytes > configuration.maximumBytes) { limited = true; stop(); return; }
    if (stderr) process.stderr.write(chunk);
    else if (mode === 'canary') stdout += chunk.toString('utf8');
    else {
      if (mode === 'lifetime_fixture' && chunk.toString('utf8').includes('namespace fixture ready')) {
        process.stdout.write(JSON.stringify({ ownedNamespacePids: await descendants(child.pid) }) + '\n');
      }
      process.stdout.write(chunk);
    }
  };
  child.stdout.on('data', chunk => consume(chunk, false)); child.stderr.on('data', chunk => consume(chunk, true));
  child.stdout.on('error', stop); child.stderr.on('error', stop);
  const code = await new Promise((okay) => { child.once('error', () => { childFinished = true; okay(70); }); child.once('close', exit => { childFinished = true; okay(exit ?? 70); }); });
  clearTimeout(timer);
  if (listener) { await new Promise(okay => listener.close(okay)); listener = undefined; }
  if (mode === 'canary') {
    let result; try { result = JSON.parse(stdout); } catch { result = { schemaVersion: 'source-repair-containment-v2', fileDenied: false, networkDenied: false }; }
    process.stdout.write(JSON.stringify({ ...result, networkControl, acceptedConnections }) + '\n');
  }
  process.exitCode = stopped || limited ? 70 : code;
} finally {
  if (listener) await new Promise(okay => listener.close(okay));
  stop(); process.stdin.destroy();
}
