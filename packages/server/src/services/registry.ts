import type { Dispose } from "@atlas/contracts/server";

/** Id-keyed provider map shared by the plugin-fed registries. */
export class ProviderRegistry<Provider extends { id: string }> {
  private readonly providers = new Map<string, Provider>();

  constructor(private readonly noun: string) {}

  register(provider: Provider): Dispose {
    if (this.providers.has(provider.id)) {
      throw new Error(`${this.noun} "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
    return () => {
      if (this.providers.get(provider.id) === provider) {
        this.providers.delete(provider.id);
      }
    };
  }

  get(providerId: string): Provider | undefined {
    return this.providers.get(providerId);
  }

  list(): Provider[] {
    return [...this.providers.values()];
  }

  clear(): void {
    this.providers.clear();
  }
}
