import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

async function main() {
  await Template.build(template, 'start1-nextjs', {
    onBuildLogs: defaultBuildLogger(),
  });
}

main().catch(console.error);