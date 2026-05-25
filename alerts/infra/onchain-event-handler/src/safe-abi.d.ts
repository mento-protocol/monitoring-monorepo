/**
 * Type definitions for Safe contract ABI
 */

export interface ABIInput {
  indexed?: boolean;
  internalType?: string;
  name: string;
  type: string;
}

export interface ABIItem {
  anonymous?: boolean;
  inputs?: ABIInput[];
  name?: string;
  type: string;
  stateMutability?: string;
  outputs?: ABIInput[];
}

declare const safeAbi: ABIItem[];
export default safeAbi;
