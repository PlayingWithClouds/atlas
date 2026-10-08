<script lang="ts">
	// A small keyboard-shortcut hint (keycap). Uses currentColor so it reads on any
	// button background (ghost, primary, …).
	let { label }: { label: string } = $props();
</script>

<span class="ml-1 rounded border border-current/30 px-1 font-mono text-[10px] opacity-60">{label}</span>
