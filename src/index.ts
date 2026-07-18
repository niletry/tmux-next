import { startServer } from "./server";

const portArg = process.argv.indexOf("--port");
const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 7682;
const server = startServer(port);

console.log(`listening on http://127.0.0.1:${server.port}`);
