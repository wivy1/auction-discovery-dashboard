export interface AssetClassContext {
  title?: string | null;
  includedItems?: readonly string[];
  sourceText?: string | null;
}

const CABINET = /\bcabinets?\b/i;
const CABINET_SUPPORT_CONTENT = /(?:\bcabinets?\s+(?:accessories|components|hardware|parts)\b|\b(?:accessories|components|hardware|parts)\s+(?:for|of)\s+(?:a\s+)?cabinet\b)/i;

const EXPLICIT_EQUIPMENT_CLASSES = [
  { name: "Desktop Computer", pattern: /\b(?:all[ -]in[ -]one\s+computers?|aio\s+computers?|desktop\s+computers?|desktops?|imacs?(?:\s+desktops?)?|mini\s+desktop\s+computers?|optiplex(?:\s+all[ -]in[ -]one)?\s+computers?)\b/i },
  { name: "Laptop Computer", pattern: /\b(?:gaming\s+laptops?|laptop\s+computers?|laptops?|thinkpads?)\b/i },
  { name: "Tablet Computer", pattern: /\bipads?\b|\btablet\s+computers?\b/i },
  { name: "Thin Client", pattern: /\bthin\s+clients?\b/i },
  { name: "Computer", pattern: /\b(?:assorted\s+)?computers?\b/i },
  { name: "Computing Workstation", pattern: /\b(?:mobile\s+)?computing\s+workstations?\b|\bmac\s+pro\b/i },
  { name: "Workstation", pattern: /\bworkstations?\b/i },
  { name: "Camcorder", pattern: /\bcamcorders?\b/i },
  { name: "Network Switch", pattern: /\b(?:network\s+)?switches?\b|\bcatalyst\s+\d{4}\b/i },
  { name: "Printer", pattern: /\b(?:label|medical\s+thermal\s+strip|slide|thermal\s+strip)?\s*printers?\b/i },
  { name: "Projector", pattern: /\bprojectors?\b/i },
  { name: "Keyboard", pattern: /\bkeyboards?\b/i },
  { name: "Two-Way Radio", pattern: /\bwalkie[ -]talk(?:ie|ies)(?:\s+devices?)?\b/i },
  { name: "Power Distribution Unit", pattern: /\b(?:data\s+center\s+)?pdu\b|\bpower\s+distribution\s+units?\b/i },
  { name: "Uninterruptible Power Supply", pattern: /\bups(?:\s+units?)?\b/i },
  { name: "Power Supply", pattern: /\bpower\s+suppl(?:y|ies)\b/i },
  { name: "Fetal Monitor", pattern: /\b(?:fetal|maternal(?:\s*\/\s*fetal)?)\s+monitors?\b/i },
  { name: "Patient Monitor", pattern: /\b(?:patient|vital[ -]?signs?)\s+monitors?\b/i },
  { name: "Patient Monitoring System", pattern: /\bpatient\s+monitoring\s+systems?\b|\bphysiomonitoring\s+systems?\b/i },
  { name: "Defibrillator", pattern: /\bdefibrillators?\b/i },
  { name: "Electrocardiograph", pattern: /\b(?:ecg|ekg|electrocardiograph)(?:\s+(?:machine|system|unit))?\b/i },
  { name: "Anesthesia Machine", pattern: /\banesthesi(?:a|ology)\s+(?:machines?|systems?|units?)\b/i },
  { name: "Epidural Anesthesia Tray", pattern: /\bepidural\s+anesthesia\s+trays?\b/i },
  { name: "Centrifuge", pattern: /\bcentrifuges?\b/i },
  { name: "Slide Stainer", pattern: /\bslide\s+stainers?\b/i },
  { name: "Microscope", pattern: /\bmicroscopes?\b/i },
  { name: "Flow Cytometer", pattern: /\bflow\s+cytometers?\b/i },
  { name: "Coagulation Analyzer", pattern: /\bcoagulation\s+analy[sz]ers?\b/i },
  { name: "Glucose and Lactate Analyzer", pattern: /\bglucose\s+and\s+lactate\s+analy[sz]ers?\b/i },
  { name: "Body Composition Analyzer", pattern: /\bbody\s+composition\s+analy[sz]ers?\b/i },
  { name: "Urodynamic Analyzer", pattern: /\burodynamic\s+analy[sz]ers?\b/i },
  { name: "Television", pattern: /\b(?:televisions?|tvs?|tv\s+monitors?)\b/i },
  { name: "Fitness Equipment", pattern: /\b(?:exercise(?:\s+rehabilitation)?|fitness)\s+(?:equipment|machines?)\b|\btreadmills?\b/i },
  { name: "Scientific Equipment", pattern: /\bscience\s+equipment\b/i },
  { name: "Chromatography Module", pattern: /\bchromatograph(?:y|ic)\s+(?:detectors?|modules?)\b/i },
  { name: "Ion Chromatography System", pattern: /\bion\s+chromatograph(?:y|ic)\s+systems?\b/i },
  { name: "Gas Absorption Unit", pattern: /\bgas\s+absorption\s+units?\b/i },
  { name: "Laboratory Furnace", pattern: /\b(?:laboratory|lab|quick)\s+furnaces?\b/i },
  { name: "Laboratory Oven", pattern: /\b(?:laboratory|lab)\s+ovens?\b/i },
  { name: "Oven", pattern: /\bovens?\b/i },
  { name: "Water Bath", pattern: /\b(?:digital\s+)?water\s+baths?\b/i },
  { name: "Recirculating Chiller", pattern: /\brecirculating\s+chillers?\b/i },
  { name: "Vibration Table", pattern: /\bvibration\s+tables?\b/i },
  { name: "Vapor Pressure Tester", pattern: /\bvapor\s+pressure\s+testers?\b/i },
  { name: "Block Heater", pattern: /\b(?:single\s+)?block\s+heaters?\b/i },
  { name: "Fluid Warmer", pattern: /\bfluid\s+warmers?\b/i },
  { name: "Pump", pattern: /\b(?:air\s+transfer\s+system\s+|vacuum\s+)?pumps?\b/i },
  { name: "Ultrasound Transducer", pattern: /\bultrasound\s+transducers?\b/i },
  { name: "Ultrasound System", pattern: /\b(?:portable\s+)?ultrasound\s+systems?\b/i },
  { name: "MRI Coil", pattern: /\bmri\s+coils?\b/i },
  { name: "IBP Cable", pattern: /\bibp\s+cables?\b/i },
  { name: "Adapter Cable", pattern: /\badapter\s+cables?\b/i },
  { name: "Wall Transformer", pattern: /\bwall\s+transformers?\b/i },
  { name: "Information Management System", pattern: /\binformation\s+management\s+systems?\b/i },
  { name: "Laser System", pattern: /\blaser\s+(?:control\s+)?systems?\b/i },
  { name: "Laser Positioning System", pattern: /\blaser\s+positioning\s+systems?\b/i },
  { name: "Nebulizer", pattern: /\bnebulizers?\b/i },
  { name: "Splint Bath", pattern: /\bsplint\s+baths?\b/i },
  { name: "Incubator", pattern: /\bincubators?\b/i },
  { name: "Surgical Light", pattern: /\bsurgical\s+lights?\b/i },
  { name: "Medical Lamp", pattern: /\bgooseneck\s+lamps?\b/i },
  { name: "Medical Light", pattern: /\b(?:maquet\s+lucea\s+\d+|medical)\s+lights?\b/i },
  { name: "MRI Table", pattern: /\bmri\s+tables?\b/i },
  { name: "Overbed Table", pattern: /\bover[ -]?the[ -]?bed\s+tables?\b|\boverbed\s+tables?\b/i },
  { name: "Treatment Table", pattern: /\btreatment\s+tables?\b/i },
  { name: "Exam Table", pattern: /\bexam(?:ination|s)?\s+tables?\b/i },
  { name: "Exam Bed", pattern: /\bexam\s+beds?\b/i },
  { name: "Hospital Bed", pattern: /\b(?:birthing|hospital|total\s+care)\s+beds?\b/i },
  { name: "Surgical Table", pattern: /\b(?:general\s+purpose\s+)?surg(?:ery|ical)\s+tables?\b/i },
  { name: "Orthopedic Table", pattern: /\b(?:echo|fracture\s+traction|orthopedic)\s+(?:arc\s+cart\s+)?tables?\b/i },
  { name: "IV Pole", pattern: /\biv\s+poles?\b/i },
  { name: "Medical Pole", pattern: /\b(?:adjustable|medical)\s+poles?\b/i },
  { name: "Positioning Platform", pattern: /\bpositioning\s+platforms?\b/i },
  { name: "Wheelchair", pattern: /\bwheel\s*chairs?\b/i },
  { name: "Stretcher", pattern: /\bstretchers?\b/i },
  { name: "Stretcher Mattress", pattern: /\bstretcher\s+mat+tresses?\b/i },
  { name: "Procedure Chair", pattern: /\b(?:clinical|procedure|stretcher)\s+chairs?\b/i },
  { name: "Patient Lift", pattern: /\bpatient\s+lifts?\b/i },
  { name: "Hospital Bassinet", pattern: /\b(?:hospital\s+series\s+)?bassi(?:nest|net)s?\b/i },
  { name: "Medical Scale", pattern: /\b(?:adult|in[ -]?bed|patient)\s+(?:weighing\s+)?scales?\b/i },
  { name: "Scale", pattern: /\b(?:weighing\s+)?scales?\b/i },
  { name: "Endoscope Drying Cabinet", pattern: /\bendoscope\s+drying\s+cabinets?\b/i },
  { name: "Pharmacy Refrigerator", pattern: /\bpharmacy\s+refrigerators?\b/i },
  { name: "Freezer", pattern: /\b(?:chest|laboratory|lab|ultra[ -]low(?:\s+temperature)?)\s+freezers?\b/i },
  { name: "Docking Station", pattern: /\bdocking\s+stations?\b/i },
  { name: "Spectrophotometer", pattern: /\bspectrophotometers?\b/i },
  { name: "Autosampler", pattern: /\b(?:automated\s+samplers?|autosamplers?)\b/i },
  { name: "Elemental Analyzer", pattern: /\belemental\s+analy[sz]ers?\b/i },
  { name: "Phacoemulsification System", pattern: /\bphacoemulsification\s+systems?\b/i },
  { name: "CT Scanner", pattern: /\bct\s+scanners?\b/i },
  { name: "C-Arm Imaging System", pattern: /\b(?:mini\s+)?c[ -]?arms?\b/i },
  { name: "Radiography System", pattern: /\b(?:radiography\s+systems?|mobile\s*x[ -]?rays?(?:\s+systems?)?)\b|\bmobilediagnost\b/i },
  { name: "Radiography Detector", pattern: /\bportable\s+rf\s+units?\b/i },
  { name: "Digital Capture System", pattern: /\bdigital\s+capture\s+systems?\b/i },
  { name: "Surgical Flow Meter", pattern: /\bsurgical\s+flow\s+meters?\b/i },
  { name: "Foot Switch", pattern: /\bfoot\s+switch(?:es)?\b/i },
  { name: "Compressor", pattern: /\bcompressors?\b/i },
  { name: "Respiratory Humidifier", pattern: /\b(?:respiratory\s+)?humidifiers?\b/i },
  { name: "Telemetry Module", pattern: /\btelemetry\s+(?:modules?|t\d+[a-z0-9-]*)\b/i },
  { name: "Medical Module", pattern: /\b(?:cam\s*14|cam\s*hd)\s+modules?\b/i },
  { name: "Patient Data Module", pattern: /\bpatient\s+data\s+modules?\b/i },
  { name: "Clinical Information Station", pattern: /\bclinical\s+information\s+stations?\b/i },
  { name: "Medical Information Portal", pattern: /\b(?:medical\s+)?information\s+portals?\b/i },
  { name: "Light Source", pattern: /\blight\s+sources?\b/i },
  { name: "Doppler", pattern: /\b(?:mini)?dopplers?\b/i },
  { name: "Tissue Oximeter", pattern: /\btissue\s+oximeters?\b/i },
  { name: "Detector Array", pattern: /\b(?:multi[ -])?detector\s+arrays?\b/i },
  { name: "Xenon System", pattern: /\bxenon\s+systems?\b/i },
  { name: "CPR Board", pattern: /\bcpr\s+boards?\b/i },
  { name: "TeleSitter Camera System", pattern: /\btelesitter\s+camera\s+systems?\b/i },
  { name: "Crash Cart", pattern: /\b(?:emergency\s+|pediatric\s+)?crash\s+carts?\b/i },
  { name: "Medical Cart", pattern: /\b(?:equipment|medical)\s+carts?\b/i },
  { name: "Linen Cart", pattern: /\blinen\s+carts?\b/i },
  { name: "Meal Delivery Cart", pattern: /\bmeal\s+delivery\s+carts?\b/i },
  { name: "Cart", pattern: /\bcarts?\b/i },
  { name: "Medical Stand", pattern: /\bmedical(?:\s+mobile)?\s+stands?\b/i },
  { name: "Equipment Case", pattern: /\b(?:equipment|respironics)\s+cases?\b/i },
  { name: "Infant Warmer", pattern: /\binfant\s+warmer\s+systems?\b/i },
  { name: "Milk Warmer", pattern: /\b(?:medela\s+)?warmers?\b/i },
  { name: "Feeding Pump", pattern: /\b(?:enteral\s+feeding|kangaroo\s+e?pump)\b/i },
  { name: "Infusion Pump", pattern: /\binfusion\s+pumps?\b/i },
  { name: "Rapid Infuser", pattern: /\brapid\s+infusers?\b/i },
  { name: "Phototherapy System", pattern: /\bphototherapy\s+systems?\b/i },
  { name: "Air Transfer System", pattern: /\bair\s+transfer\s+systems?\b/i },
  { name: "Delivery System", pattern: /\bdelivery\s+systems?\b/i },
  { name: "Endovascular Control Unit", pattern: /\bendovascular\s+control\s+units?\b/i },
  { name: "Pneumatic Controller", pattern: /\bpneumatic\s+controllers?\b/i },
  { name: "Contrast Injector", pattern: /\bcontrast\s+injector(?:\s+heads?|\s+systems?)?\b/i },
  { name: "Fluid Management System", pattern: /\bfluid\s+management\s+systems?\b/i },
  { name: "Temperature Management System", pattern: /\btemperature\s+management\s+systems?\b/i },
  { name: "Smoke Evacuator", pattern: /\bsmoke\s+evacuators?\b/i },
  { name: "Scope Guide Console", pattern: /\bscope\s+guide\s+consoles?\b/i },
  { name: "Medical Optometry Unit", pattern: /\b(?:medical\s+)?optometry\s+units?\b/i },
  { name: "Medical Booth", pattern: /\bmedical\s+booths?\b|\bmcg\s+booths?\b/i },
  { name: "Medical Device", pattern: /\bmedical\s+devices?\b/i },
  { name: "Bladder Scanner", pattern: /\bbladder\s*scans?\b/i },
  { name: "Endoscope Sterilization System", pattern: /\bdisinfection\s+sterilization\s+systems?\b/i },
  { name: "Washer-Disinfector", pattern: /\b(?:medical\s+)?washers?\s*[-/]?\s*d[ei]sinfectors?\b/i },
  { name: "Electrosurgical Generator", pattern: /\belectro\s*surgical\s+generators?\b/i },
  { name: "Battery Charger", pattern: /^(?![^\n]*\b(?:with|w\/)\b[^\n]*\bbattery\s+charger)[^\n]*\bbattery\s+chargers?\b/im },
  { name: "Drill", pattern: /\b(?:short\s+)?drills?\b/i },
  { name: "Patient Assist Bar", pattern: /\bpatient\s+(?:helper\s+)?assist\s+bars?\b/i },
  { name: "X-Ray Tube", pattern: /\bx[ -]?ray\s+tubes?\b/i },
  { name: "Fixation Pin", pattern: /\bfixation\s+(?:threaded\s+)?(?:steinmann\s+)?(?:pins?|devices?)\b/i },
  { name: "Rotablator", pattern: /\brotablators?\b/i },
  { name: "Surgical Stapler", pattern: /\b(?:gastric\s+)?staplers?\b/i },
  { name: "Surgical Stapler Reload", pattern: /\b(?:linear\s+cutter|stapler)\s+reloads?\b/i },
  { name: "Trocar", pattern: /\btrocars?\b/i },
  { name: "Surgical Retractor", pattern: /\bretractors?\b|\bvaginal[ -]cervical\b[^\n]{0,80}\belevators?\b/i },
  { name: "Surgical Handpiece", pattern: /\b(?:handpieces?|switching\s+probes?)\b/i },
  { name: "Medical Catheter", pattern: /\b(?:foley|intrauterine\s+pressure|medical)?\s*catheters?\b/i },
  { name: "Guidewire", pattern: /\bguidewires?\b/i },
  { name: "Flush Syringe", pattern: /\bflush\s+syringes?\b/i },
  { name: "Cortical Screw", pattern: /\bcortical\s+screws?\b/i },
  { name: "PEG Kit", pattern: /\bpeg\s+kits?\b/i },
  { name: "Electrosurgical Pencil", pattern: /\bswitch\s+pencils?\b/i },
  { name: "Medical Bin", pattern: /\b(?:linen|medical\s+trash)\s+bins?\b/i },
  { name: "Clip Applier", pattern: /\bclip\s+appliers?\b/i },
  { name: "Medical Disposable", pattern: /\bmedical\s+dis(?:posables?|ponsables?)\b/i },
  { name: "Surgical Supply", pattern: /\b(?:laparoscopic\s+)?surgical\s+supplies?\b/i },
  { name: "Plaster Bandage", pattern: /\bplaster\s+bandages?\b/i },
  { name: "Sterilization Tray", pattern: /\bsterilization\s+trays?\b/i },
  { name: "Monitor", pattern: /\bmonitors?\b/i },
] as const;

function normalizedClass(value: string): string {
  return value.trim().replaceAll("_", " ").replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function identifiesCabinet(value: string | null | undefined): boolean {
  if (!value) return false;
  return CABINET.test(value) && !CABINET_SUPPORT_CONTENT.test(value);
}

/**
 * Adds narrow deterministic taxonomy aliases without replacing the immutable
 * model extraction. A listing must identify a cabinet both in its source title
 * and in an extracted included item, which avoids treating incidental cabinets
 * or cabinet parts as the primary asset.
 */
export function effectiveAssetClasses(
  assetClasses: readonly string[],
  context: AssetClassContext = {},
): string[] {
  const classes: string[] = [];
  const seen = new Set<string>();
  for (const value of assetClasses) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const normalized = normalizedClass(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    classes.push(trimmed);
  }

  const titleIsCabinet = identifiesCabinet(context.title);
  const includedCabinet = context.includedItems?.some(identifiesCabinet) ?? false;
  const alreadyFurniture = classes.some((value) => /\bfurniture\b/i.test(normalizedClass(value)));
  if (titleIsCabinet && includedCabinet && !alreadyFurniture) {
    seen.add(normalizedClass("Furniture"));
    classes.push("Furniture");
  }

  // A model may return a broad class such as "medical equipment" even when
  // the source title names the exact equipment type. Keep the model output as
  // evidence, then add only explicit, source-grounded refinements shared by
  // every adapter.
  const primaryEvidence = [context.title, ...(context.includedItems ?? [])]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
  const fallbackEvidence = primaryEvidence || context.sourceText || "";
  for (const rule of EXPLICIT_EQUIPMENT_CLASSES) {
    if (!rule.pattern.test(fallbackEvidence)) continue;
    const normalized = normalizedClass(rule.name);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    classes.push(rule.name);
  }
  return classes.slice(0, 50);
}
