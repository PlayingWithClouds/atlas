<script lang="ts">
	import { marked } from 'marked';

	let { text }: { text: string } = $props();

	// Model output is not trusted enough to inject as markup, so angle brackets are
	// escaped before marked runs. Markdown itself survives — only raw HTML is defused.
	function render(source: string): string {
		const escaped = source.replace(/</g, '&lt;').replace(/>/g, '&gt;');
		return marked.parse(escaped, { async: false, breaks: true }) as string;
	}
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -->
<div class="markdown text-sm leading-relaxed">{@html render(text)}</div>

<style>
	/* Styled against the design tokens rather than a prose preset, so the assistant's
	   answers follow the app's theme in both light and dark. */
	.markdown :global(p) {
		margin-block: 0.5rem;
	}
	.markdown :global(p:first-child) {
		margin-top: 0;
	}
	.markdown :global(p:last-child) {
		margin-bottom: 0;
	}
	.markdown :global(h1),
	.markdown :global(h2),
	.markdown :global(h3),
	.markdown :global(h4) {
		margin-block: 0.75rem 0.35rem;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text);
	}
	.markdown :global(ul),
	.markdown :global(ol) {
		margin-block: 0.4rem;
		padding-left: 1.1rem;
	}
	.markdown :global(ul) {
		list-style: disc;
	}
	.markdown :global(ol) {
		list-style: decimal;
	}
	.markdown :global(li) {
		margin-block: 0.2rem;
	}
	.markdown :global(strong) {
		font-weight: 600;
		color: var(--text);
	}
	.markdown :global(em) {
		font-style: italic;
	}
	.markdown :global(a) {
		color: var(--ctx-blue);
		text-decoration: underline;
	}
	.markdown :global(code) {
		background: var(--surface-raised);
		border-radius: var(--radius-xs);
		padding: 0.05rem 0.3rem;
		font-size: var(--text-2xs);
	}
	.markdown :global(pre) {
		background: var(--surface-raised);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 0.6rem;
		margin-block: 0.5rem;
		overflow-x: auto;
	}
	.markdown :global(pre code) {
		background: none;
		padding: 0;
	}
	.markdown :global(blockquote) {
		border-left: 2px solid var(--border-strong);
		padding-left: 0.6rem;
		color: var(--text-muted);
		margin-block: 0.5rem;
	}
	.markdown :global(hr) {
		border: none;
		border-top: 1px solid var(--border);
		margin-block: 0.75rem;
	}
	.markdown :global(table) {
		width: 100%;
		border-collapse: collapse;
		margin-block: 0.5rem;
		font-size: var(--text-2xs);
	}
	.markdown :global(th),
	.markdown :global(td) {
		border: 1px solid var(--border);
		padding: 0.25rem 0.4rem;
		text-align: left;
	}
</style>
