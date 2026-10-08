import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { defineConfig } from 'vite';
import { atlasWorkspacePlugins } from './vite/workspacePlugins';

// Relative ATLAS_WORKSPACE values are relative to the repo root, like the server's.
const repositoryRoot = path.join(import.meta.dirname, '../..');
const workspaceDirectory = path.resolve(repositoryRoot, process.env.ATLAS_WORKSPACE ?? '.atlas-workspace');
const apiTarget = `http://localhost:${process.env.ATLAS_PORT ?? 8123}`;

// The browser talks to the server same-origin: /api (REST + WebSocket) is proxied, so
// <img src="/api/..."> works with relative URLs and no CORS is involved.
export default defineConfig({
	plugins: [
		tailwindcss(),
		svelte(),
		atlasWorkspacePlugins(workspaceDirectory, path.join(import.meta.dirname, 'src/lib/design/plugin-sources.css'))
	],
	// Plugin web entries live outside this package and must share its single Svelte runtime.
	resolve: { dedupe: ['svelte'] },
	server: {
		proxy: {
			'/api': {
				target: apiTarget,
				changeOrigin: true,
				ws: true,
				// A tab closing mid-write makes the proxy throw EPIPE/ECONNRESET; those are benign.
				configure: (proxy) => {
					proxy.on('error', (error) => {
						const code = (error as NodeJS.ErrnoException).code;
						if (code === 'EPIPE' || code === 'ECONNRESET') {
							return;
						}
						console.error('[proxy] /api error:', error.message);
					});
				}
			}
		}
	}
});
