import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(__dirname, '../../.env') })

import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

async function main() {
  await Template.build(template, 'start1-nextjs-dev', {
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  });
}

main().catch(console.error);