import {
  createAddressLink,
  createProposalLink,
  createTransactionLink,
} from "../utils/url-builders";

/**
 * Abstract base class for message builders
 * Eliminates duplication between Discord and Telegram builders
 * @template T The type returned by the build() method
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export abstract class MessageBuilder<T> {
  /**
   * Platform-specific method to add a field to storage
   * @param name Field name
   * @param value Field value
   */
  protected abstract addFieldToStorage(name: string, value: string): void;

  /**
   * Add proposal link field
   */
  addProposalLink(proposalId: bigint): this {
    this.addFieldToStorage("Proposal Link", createProposalLink(proposalId));
    return this;
  }

  /**
   * Add transaction link field
   */
  addTransactionLink(transactionHash: string, label = "Transaction"): this {
    this.addFieldToStorage(
      `${label} Transaction`,
      createTransactionLink(transactionHash),
    );
    return this;
  }

  /**
   * Add proposer address field
   */
  addProposerLink(proposer: string, label = "Proposer"): this {
    this.addFieldToStorage(label, createAddressLink(proposer));
    return this;
  }

  /**
   * Add timelock ID field
   */
  addTimelockId(timelockId?: string): this {
    this.addFieldToStorage("Timelock ID", timelockId ?? "N/A");
    return this;
  }

  /**
   * Add execution time field
   */
  addExecutionTime(eta: bigint): this {
    const executionTime = new Date(Number(eta) * 1000).toUTCString();
    this.addFieldToStorage("Execution Time", executionTime);
    return this;
  }

  /**
   * Add custom field
   */
  addField(name: string, value: string): this {
    this.addFieldToStorage(name, value);
    return this;
  }

  /**
   * Build the final message
   */
  abstract build(): T;
}
