export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getRuntime } = await import("./lib/runtime");
    getRuntime();
  }
}
