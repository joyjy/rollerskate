import { runCommandWorker } from "../../application/command/worker.js";

process.once("message", runCommandWorker);
