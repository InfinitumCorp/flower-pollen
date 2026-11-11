// Copies the FLOWER(TM) & POLLEN(TM) OpenClaw skill into the local OpenClaw skills folder.
// Usage: npm run openclaw:install   (target: $OPENCLAW_HOME/skills or ~/.openclaw/skills)
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'integrations', 'openclaw', 'flower-pollen');
const home = process.env.OPENCLAW_HOME ?? join(homedir(), '.openclaw');
if (!existsSync(home)) {
  console.error(`OpenClaw folder not found at ${home}. Install OpenClaw first or set OPENCLAW_HOME.`);
  process.exit(1);
}
const dest = join(home, 'skills', 'flower-pollen');
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`Installed the flower-pollen skill to ${dest}
Next: create an agent key (POST /v1/keys {"name":"openclaw","role":"agent"} as a commander) and give it to
OpenClaw as FP_API_KEY in its environment, plus FP_URL if the backend is not on http://127.0.0.1:8080.`);
