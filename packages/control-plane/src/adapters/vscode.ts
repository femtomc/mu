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

const VSCODE_SHARED_SECRET_HEADER = "x-mu-vscode-secret";

export const VscodeControlPlaneAdapterSpec = createFrontendAdapterSpec({
	channel: "vscode",
	route: defaultWebhookRouteForChannel("vscode"),
	sharedSecretHeader: VSCODE_SHARED_SECRET_HEADER,
});

export type VscodeControlPlaneAdapterOpts = {
	pipeline: ControlPlaneCommandPipeline;
	sharedSecret: string;
	nowMs?: () => number;
};

export const VscodeIngressPayloadSchema = FrontendIngressPayloadSchema;
export type VscodeIngressPayload = FrontendIngressPayload;

export class VscodeControlPlaneAdapter extends FrontendControlPlaneAdapter {
	public constructor(opts: VscodeControlPlaneAdapterOpts) {
		super({
			pipeline: opts.pipeline,
			spec: VscodeControlPlaneAdapterSpec,
			sharedSecretHeader: VSCODE_SHARED_SECRET_HEADER,
			sharedSecret: opts.sharedSecret,
			nowMs: opts.nowMs,
		});
	}
}
