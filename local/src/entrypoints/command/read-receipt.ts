import { commandCompletion } from "../../application/command/query.js";

const commandId = process.argv[2] ?? "";
process.stdout.write(JSON.stringify(commandCompletion(process.argv[3] ?? process.cwd(), commandId)));
