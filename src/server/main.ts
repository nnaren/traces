#!/usr/bin/env node
import { startServer } from './http.ts';

const argv = process.argv.slice(2);
const arg = (name: string, dflt: string) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const dataDir = arg('data-dir', process.env.TRAJVIEW_DATA ?? './data');
const port = Number(arg('port', process.env.PORT ?? '5178'));
const host = arg('host', '127.0.0.1');

await startServer({ dataDir, port, host });
