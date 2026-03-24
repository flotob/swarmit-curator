/**
 * Protocol constants — shared between SPA and curator.
 */

export const PROTOCOL_VERSION = 'v1';
export const PROTOCOL_PREFIX = 'freedom-board';

export const TYPES = {
  BOARD: `${PROTOCOL_PREFIX}/board/${PROTOCOL_VERSION}`,
  POST: `${PROTOCOL_PREFIX}/post/${PROTOCOL_VERSION}`,
  REPLY: `${PROTOCOL_PREFIX}/reply/${PROTOCOL_VERSION}`,
  SUBMISSION: `${PROTOCOL_PREFIX}/submission/${PROTOCOL_VERSION}`,
  USER_FEED: `${PROTOCOL_PREFIX}/user-feed/${PROTOCOL_VERSION}`,
  BOARD_INDEX: `${PROTOCOL_PREFIX}/board-index/${PROTOCOL_VERSION}`,
  THREAD_INDEX: `${PROTOCOL_PREFIX}/thread-index/${PROTOCOL_VERSION}`,
  GLOBAL_INDEX: `${PROTOCOL_PREFIX}/global-index/${PROTOCOL_VERSION}`,
  CURATOR: `${PROTOCOL_PREFIX}/curator/${PROTOCOL_VERSION}`,
};
