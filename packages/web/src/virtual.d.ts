declare module 'virtual:atlas-plugins' {
	export interface WorkspaceWebPlugin {
		name: string;
		config: Record<string, unknown>;
		load: () => Promise<{ default: unknown }>;
	}
	const plugins: WorkspaceWebPlugin[];
	export default plugins;
}
