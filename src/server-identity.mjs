import { createHmac, timingSafeEqual } from 'node:crypto';

export const validIdentityNonce = nonce => typeof nonce === 'string' && /^[a-f0-9]{64}$/.test(nonce);

export function identityProof(token, nonce, clientPort, serverPort) {
  return createHmac('sha256', token).update(`naru-server-identity-v1\n${nonce}\n${clientPort}\n${serverPort}`).digest('hex');
}

export function verifyIdentity(token, nonce, result, socket) {
  if (result?.nonce !== nonce || !validIdentityNonce(result?.proof) ||
      ![socket.localPort, socket.remotePort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) return false;
  return timingSafeEqual(Buffer.from(result.proof, 'hex'),
    Buffer.from(identityProof(token, nonce, socket.localPort, socket.remotePort), 'hex'));
}
