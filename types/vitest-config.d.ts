declare module "vitest/config" {
  export function defineConfig(config: {
    test?: {
      environment?: string;
      include?: string[];
    };
  }): {
    test?: {
      environment?: string;
      include?: string[];
    };
  };
}
