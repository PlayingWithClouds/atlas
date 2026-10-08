import { plugin } from 'bun';
import { compileModule } from 'svelte/compiler';

// bun does not know runes: compile `.svelte.ts` modules (strip types first) like Vite would.
const transpiler = new Bun.Transpiler({ loader: 'ts' });

plugin({
  name: 'svelte-rune-modules',
  setup(build) {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const javascript = transpiler.transformSync(source);
      const compiled = compileModule(javascript, { filename: path, generate: 'client' });
      return { contents: compiled.js.code, loader: 'js' };
    });
  },
});
