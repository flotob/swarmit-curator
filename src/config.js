/**
 * Configuration loader — validates all required env vars on startup.
 */

import 'dotenv/config';

const required = [
  'RPC_URL',
  'CONTRACT_ADDRESS',
  'CONTRACT_DEPLOY_BLOCK',
  'BEE_URL',
  'POSTAGE_BATCH_ID',
  'CURATOR_PRIVATE_KEY',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables:\n  ${missing.join('\n  ')}`);
  console.error('\nCopy .env.example to .env and fill in the values.');
  process.exit(1);
}

const config = {
  // Chain
  rpcUrl: process.env.RPC_URL,
  contractAddress: process.env.CONTRACT_ADDRESS,
  contractDeployBlock: parseInt(process.env.CONTRACT_DEPLOY_BLOCK, 10),
  confirmations: parseInt(process.env.CONFIRMATIONS || '12', 10),
  pollInterval: parseInt(process.env.POLL_INTERVAL || '30', 10) * 1000, // ms

  // Swarm
  beeUrl: process.env.BEE_URL,
  postageBatchId: process.env.POSTAGE_BATCH_ID,

  // Curator identity — same key for feed signing, curatorProfile.curator, and CuratorDeclared msg.sender
  curatorPrivateKey: process.env.CURATOR_PRIVATE_KEY,
  curatorName: process.env.CURATOR_NAME || 'Chronological Curator',
  curatorDescription: process.env.CURATOR_DESCRIPTION || 'Spam-filtered chronological board views',

  // State (SQLite)
  stateDb: process.env.STATE_DB || './state.db',

  // Ranked views
  rankedRefreshInterval: parseInt(process.env.RANKED_REFRESH_INTERVAL || '15', 10) * 60 * 1000, // ms
};

// Derive curator address from private key
import { Wallet } from 'ethers';
const wallet = new Wallet(config.curatorPrivateKey);
config.curatorAddress = wallet.address;

export default config;

// Print config summary when run directly
if (process.argv[1]?.endsWith('config.js')) {
  console.log('Swarmit Curator — Configuration');
  console.log('================================');
  console.log(`RPC:              ${config.rpcUrl}`);
  console.log(`Contract:         ${config.contractAddress}`);
  console.log(`Deploy block:     ${config.contractDeployBlock}`);
  console.log(`Confirmations:    ${config.confirmations}`);
  console.log(`Poll interval:    ${config.pollInterval / 1000}s`);
  console.log(`Bee URL:          ${config.beeUrl}`);
  console.log(`Postage batch:    ${config.postageBatchId.slice(0, 16)}...`);
  console.log(`Curator address:  ${config.curatorAddress}`);
  console.log(`Curator name:     ${config.curatorName}`);
  console.log(`State DB:         ${config.stateDb}`);
}
