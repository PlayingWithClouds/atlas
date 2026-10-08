import type { Context } from '@neoworks/extension-system';
import { contribute } from '../shared/contribute';
import BooleanEditor from './BooleanEditor.svelte';
import NumberEditor from './NumberEditor.svelte';
import OptionEditor from './OptionEditor.svelte';
import StringEditor from './StringEditor.svelte';
import TextEditor from './TextEditor.svelte';

/** Built-in editors for the five workflow node parameter kinds. */
export const paramEditorsPlugin = {
  name: 'core-param-editors',
  inject: ['paramEditors'],
  apply(ctx: Context) {
    contribute(ctx, ctx.paramEditors, { id: 'core.param.string', kind: 'string', component: StringEditor });
    contribute(ctx, ctx.paramEditors, { id: 'core.param.text', kind: 'text', component: TextEditor });
    contribute(ctx, ctx.paramEditors, { id: 'core.param.number', kind: 'number', component: NumberEditor });
    contribute(ctx, ctx.paramEditors, { id: 'core.param.option', kind: 'option', component: OptionEditor });
    contribute(ctx, ctx.paramEditors, { id: 'core.param.boolean', kind: 'boolean', component: BooleanEditor });
  },
};
