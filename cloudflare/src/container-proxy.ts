import { ContainerProxy as SandboxContainerProxy } from "@cloudflare/sandbox";
import { handleEgress, type EgressEnv, type ProxyProps } from "./egress";

/**
 * Worker entrypoint the container runtime sends intercepted traffic to. It
 * extends the Sandbox SDK proxy, which still handles SDK-internal hosts.
 */
export class ContainerProxy extends SandboxContainerProxy {
	override async fetch(request: Request): Promise<Response> {
		const props = ((this as unknown as { ctx: { props?: ProxyProps } }).ctx.props ?? {}) as ProxyProps;
		const host = new URL(request.url).hostname;
		if (host.endsWith(".internal") || host.endsWith(".sandbox.test")) return super.fetch(request);
		return handleEgress(request, this.env as unknown as EgressEnv, props, (req) => fetch(req));
	}
}
