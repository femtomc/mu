import {
	ChannelSchema,
	type Channel,
	type OutboxDeliveryHandlerResult,
	type OutboxRecord,
} from "@femtomc/mu-control-plane";

export type OutboundDeliveryDriver = {
	channel: Channel;
	deliver: (record: OutboxRecord) => Promise<OutboxDeliveryHandlerResult>;
};

export class OutboundDeliveryRouter {
	readonly #driversByChannel = new Map<Channel, OutboundDeliveryDriver>();

	public constructor(drivers: readonly OutboundDeliveryDriver[]) {
		for (const driver of drivers) {
			if (this.#driversByChannel.has(driver.channel)) {
				throw new Error(`duplicate outbound delivery driver: ${driver.channel}`);
			}
			this.#driversByChannel.set(driver.channel, driver);
		}
	}

	public supportsChannel(channel: Channel): boolean {
		return this.#driversByChannel.has(channel);
	}

	public supportedChannels(): Channel[] {
		return [...this.#driversByChannel.keys()].sort((a, b) => a.localeCompare(b));
	}

	public async deliver(record: OutboxRecord): Promise<undefined | OutboxDeliveryHandlerResult> {
		const parsedChannel = ChannelSchema.safeParse(record.envelope.channel);
		if (!parsedChannel.success) {
			return undefined;
		}
		const driver = this.#driversByChannel.get(parsedChannel.data);
		if (!driver) {
			return undefined;
		}
		return await driver.deliver(record);
	}
}
