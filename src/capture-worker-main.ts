import { runCaptureWorker } from './capture-worker.js';
runCaptureWorker().catch(() => { process.exitCode = 1; });
