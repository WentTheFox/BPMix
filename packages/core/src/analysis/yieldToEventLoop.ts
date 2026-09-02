/** Yields to the JS event loop (a macrotask, not just a microtask) so queued UI/render/touch events get a chance to run before more synchronous work resumes. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
