#!/usr/bin/env node
import { main } from '../src/cli.js';

const { code, serving } = await main(process.argv.slice(2));
// A running listener keeps the process alive; everything else ends here.
if (!serving) process.exit(code);
