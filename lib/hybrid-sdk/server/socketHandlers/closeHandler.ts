import { decrementSocketConnectionGauge } from '../../common/utils/metrics';
import { log as logger } from '../../../logs/logger';
import { clientDisconnected } from '../infra/dispatcher';
import { getSocketConnections } from '../socket';
import { getDesensitizedToken } from '../utils/token';
import { rmClientIdFromTerminationMap } from './identifyHandler';

export const handleConnectionCloseOnSocket = (
  closeReason,
  socket,
  token,
  clientId,
  identified,
) => {
  if (token) {
    const { maskedToken, hashedToken } = getDesensitizedToken(token);
    if (identified) {
      const connections = getSocketConnections();
      const clientPool = connections
        .get(token)
        ?.filter((_) => _.socket !== socket);
      const filteredClientPool =
        clientPool?.filter((_) => _.socket !== socket) || [];
      logger.info(
        {
          closeReason,
          maskedToken,
          hashedToken,
          remainingConnectionsCount: clientPool?.length || 0,
        },
        'Client connection closed.',
      );
      if (filteredClientPool?.length) {
        connections.set(token, filteredClientPool);
      } else {
        logger.info({ maskedToken, hashedToken }, 'Removing client.');
        connections.delete(token);
      }
      decrementSocketConnectionGauge();
    } else {
      logger.warn(
        { maskedToken, hashedToken },
        'Client disconnected before identifying itself.',
      );
    }
    rmClientIdFromTerminationMap(token, clientId);
    setImmediate(async () => await clientDisconnected(token, clientId));
  }
};
