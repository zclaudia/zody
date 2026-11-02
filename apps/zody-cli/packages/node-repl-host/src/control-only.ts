import type { Duplex } from "node:stream";
import {
  createControlChannel,
  type ControlChannel,
  type ControlChannelClosedEvent,
} from "@zody/zody-cua/control-channel";
import {
  createProducerControlOwner,
  type ProducerControlOwner,
} from "@zody/zody-cua/producer-control";
import {
  ControlOnlyEntryError,
  createControlDuplex,
  hasExactControlArguments,
  parseBootstrap,
  readBootstrapLine,
  writeFailure,
  writeReady,
  type ControlOnlyChildOptions,
} from "./control-only-protocol.js";

export {
  CONTROL_ONLY_BOOTSTRAP_MAX_BYTES,
  ZCODE_NODE_REPL_CONTROL_FLAG,
  isControlOnlyInvocation,
} from "./control-only-protocol.js";

const NORMAL_CLOSE_CODES = new Set(["local_close", "disposed", "peer_eof", "transport_closed"]);

export async function runControlOnlyMain(options: ControlOnlyChildOptions = {}): Promise<number> {
  const writeStderr = options.writeStderr ?? ((text: string) => process.stderr.write(text));
  const argv = options.argv ?? process.argv;
  if (!hasExactControlArguments(argv)) {
    writeFailure(writeStderr, "invalid_arguments");
    return 1;
  }

  let owner: ProducerControlOwner | undefined;
  let channel: ControlChannel | undefined;
  let duplex: Duplex | undefined;
  try {
    const material = parseBootstrap(await readBootstrapLine(options.bootstrapFd ?? 3));
    owner = options.createOwner?.() ?? createProducerControlOwner();
    let resolveClosed!: (event: ControlChannelClosedEvent) => void;
    const closed = new Promise<ControlChannelClosedEvent>((resolve) => {
      resolveClosed = resolve;
    });
    duplex = await createControlDuplex(options.controlReadFd ?? 5, options.controlWriteFd ?? 6);
    channel = createControlChannel({
      binding: material.binding,
      duplex,
      keyId: material.producerKeyId,
      onClosed: (event) => {
        owner?.close();
        resolveClosed(event);
        void Promise.resolve(options.onClosed?.(event)).catch(() => undefined);
      },
      onRequest: options.onRequest ?? ((request) => owner!.onRequest(request)),
      privateKey: material.producerPrivateKey,
      role: "producer",
      trustedKeys: { [material.controllerKeyId]: material.controllerPublicKey },
    });
    duplex = undefined;
    await writeReady(options.readyFd ?? 4, material);
    const event = await closed;
    owner.close();
    await channel.dispose().catch(() => undefined);
    return NORMAL_CLOSE_CODES.has(event.code) ? 0 : 1;
  } catch (error) {
    writeFailure(
      writeStderr,
      error instanceof ControlOnlyEntryError ? error.code : "channel_failed",
    );
    return 1;
  } finally {
    owner?.close();
    duplex?.destroy();
    await channel?.dispose().catch(() => undefined);
  }
}
