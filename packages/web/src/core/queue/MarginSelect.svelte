<script lang="ts">
	// How close to 50 % counts as the model being unsure; a shared setting (Settings has it too).
	import Select from '../../lib/components/Select.svelte';
	import { settings } from '../settings/settings.svelte';
	import { bandText } from './apiFilter';

	const MARGINS = [0.05, 0.1, 0.15, 0.25, 0.35];

	const options = $derived(marginsWith(settings.value.unsureMargin).map((margin) => ({ value: String(margin), label: bandText(margin) })));

	/** The presets, plus a margin typed in Settings that is none of them. */
	function marginsWith(current: number): number[] {
		if (MARGINS.includes(current)) {
			return MARGINS;
		}
		return [...MARGINS, current].sort((first, second) => first - second);
	}
</script>

<div class="w-28" title="The model counts as unsure between these probabilities">
	<Select value={String(settings.value.unsureMargin)} {options} onChange={(value) => settings.update({ unsureMargin: Number(value) })} />
</div>
