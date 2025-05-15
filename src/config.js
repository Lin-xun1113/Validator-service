/**
 * 验证者服务配置
 */

require('dotenv').config();

module.exports = {
  // Magnet POW链配置
  magnet: {
    rpc: process.env.MAGNET_RPC_URL || 'https://node1.magnetchain.xyz',
    chainId: 114514,  // Magnet POW链 ID
    // 多签钱包地址（同时作为存款地址和提款处理地址）
    multiSigAddress: process.env.MAGNET_MULTISIG_ADDRESS || '0xd95fc74a2a6C7ea18B4C0eEfb3592E6B9c5a552D',
    // 将多签地址作为存款地址使用
    get depositAddress() { return this.multiSigAddress; },
    // 验证者私钥
    privateKey: process.env.MAGNET_VALIDATOR_KEY || '',
  },
  
  // BSC测试网配置
  bsc: {
    rpc: process.env.BSC_RPC_URL || 'http://data-seed-prebsc-2-s2.binance.org:8545/',
    chainId: 97,  // BSC测试网链ID
    // 验证者私钥
    privateKey: process.env.BSC_VALIDATOR_KEY || '',
    // 合约地址
    magTokenAddress: process.env.MAG_TOKEN_ADDRESS || '0xd95fc74a2a6C7ea18B4C0eEfb3592E6B9c5a552D',
    magBridgeAddress: process.env.MAG_BRIDGE_ADDRESS || '0xD95ba015968B72869fC50c3098304c4C9d233913'
  },
  
  // 存款确认所需区块数
  requiredConfirmations: 6,
  
  // 服务器配置
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || '127.0.0.1'
  },

  // 数据库配置（用于存储处理过的交易）
  db: {
    path: process.env.DB_PATH || './db/transactions.json'
  },

  // 日志级别
  logLevel: process.env.LOG_LEVEL || 'info'
};
