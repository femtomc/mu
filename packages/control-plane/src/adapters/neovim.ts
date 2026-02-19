import {
	defaultWebhookRouteForChannel,
} from "../adapter_contract.js";
import type { ControlPlaneCommandPipeline } from "../command_pipeline.js";
import {
	createFrontendAdapterSpec,
	FrontendControlPlaneAdapter,
	FrontendIngressPayloadSchema,
	type FrontendIngressPayload,
} from "./editor_frontend.js";

const NEOVIM_SHARED_SECRET_HEADER = "x-mu-neovim-secret";

export const NeovimControlPlaneAdapterSpec = createFrontendAdapterSpec({
	channel: "neovim",
	route: defaultWebhookRouteForChannel("neovim"),
	sharedSecretHeader: NEOVIM_SHARED_SECRET_HEADER,
});

export type NeovimControlPlaneAdapterOpts = {
	pipeline: ControlPlaneCommandPipeline;
	sharedSecret: string;
	nowMs?: () => number;
};

export const NeovimIngressPayloadSchema = FrontendIngressPayloadSchema;
export type NeovimIngressPayload = FrontendIngressPayload;

export class NeovimControlPlaneAdapter extends FrontendControlPlaneAdapter {
	public constructor(opts: NeovimControlPlaneAdapterOpts) {
		super({
			pipeline: opts.pipeline,
			spec: NeovimControlPlaneAdapterSpec,
			sharedSecretHeader: NEOVIM_SHARED_SECRET_HEADER,
			sharedSecret: opts.sharedSecret,
			nowMs: opts.nowMs,
		});
	}
}
