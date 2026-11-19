// The Web Function entry point: Lambda routes HTTPS requests to port 3000.
// The evictor (stream.mjs) is a separate, normal Lambda function built from this folder.
import { buildApp } from './app.mjs';

const app = buildApp({ logger: true });
await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
