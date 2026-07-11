import { createKernel, type KernelOptions } from "@minerva/kernel";
import { createStreamTransport } from "@minerva/protocol";

/**
 * Host the kernel on stdio with ACP framing — this is what an editor (Zed,
 * Neovim) spawns as its agent. stdout belongs to the protocol, so nothing
 * here may ever write to it; diagnostics go to stderr.
 */
export async function runAcpHost(options: KernelOptions): Promise<void> {
  const transport = createStreamTransport(process.stdin, process.stdout);
  const kernel = createKernel(transport, options);
  await new Promise<void>((resolve) => {
    transport.onClose(resolve);
  });
  // Flush session logs before exiting on editor disconnect.
  await kernel.close();
}
