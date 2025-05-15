# Magnet POW <-> BSC 跨链桥验证者服务

该验证者服务用于在Magnet POW链和BSC测试网之间实现安全的跨链资产转移。

## 功能特性

- 监听Magnet POW链上存款事件
- 在BSC链上确认跨链交易
- 实现多签验证机制
- 监听BSC链上的提款事件

## 安装与配置

### 前置条件

- Node.js 14+
- 提供稳定的Magnet POW链和BSC链的RPC访问
- 已部署的MAGToken和MAGBridge合约

### 安装步骤

1. 克隆仓库并安装依赖包

```bash
cd validator-service
npm install
```

2. 创建环境变量文件

```bash
cp .env.example .env
```

3. 编辑.env文件，填写必要的配置信息：

```plaintext
# Magnet POW链配置
MAGNET_RPC_URL=https://node1.magnetchain.xyz
MAGNET_DEPOSIT_ADDRESS=0x1234567890abcdef1234567890abcdef12345678
MAGNET_VALIDATOR_KEY=your_private_key_here

# BSC测试网配置
BSC_RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545/
BSC_VALIDATOR_KEY=your_private_key_here
MAG_TOKEN_ADDRESS=0xabcdef1234567890abcdef1234567890abcdef12
MAG_BRIDGE_ADDRESS=0x9876543210abcdef9876543210abcdef98765432

# 其他配置
DB_PATH=./db/transactions.json
LOG_LEVEL=info
```

## 使用方法

### 启动验证者服务

开发环境启动：

```bash
npm run dev
```

生产环境启动：

```bash
npm start
```

### 部署上线

推荐使用PM2进行生产环境部署：

```bash
# 安装PM2
npm install -g pm2

# 启动服务
pm2 start src/index.js --name "mag-bsc-bridge-validator"

# 设置开机自启
pm2 save
pm2 startup
```

## 工作原理

### Magnet -> BSC 跨链流程

1. 用户在Magnet POW链上发送MAG到指定存款地址
2. 验证者服务监测到该交易并等待足够的确认数
3. 交易确认后，验证者调用BSC上的MAGBridge合约确认交易
4. 当足够多的验证者确认后，MAGBridge合约调用MAGToken合约铸造对应数量的MAG代币给用户

### BSC -> Magnet 跨链流程

1. 用户在BSC上调用MAGBridge合约的withdraw方法发起提款请求
2. 验证者服务监听到CrossChainWithdraw事件
3. 验证者服务处理提款请求（目前需手动操作）

## 注意事项

- 请妥善保管验证者私钥，不要在代码中明文存储
- 建议部署多个验证者节点以提高可靠性和安全性
- 确保验证者账户有足够的BNB用于支付Gas费用
- 定期备份数据库文件(./db/transactions.json)

## 扩展按需实现

- 实现BSC -> Magnet方向的自动转账处理
- 添加交易监控和通知功能
- 实现Web管理界面

## 文件结构

- `src/index.js` - 主程序入口
- `src/magnetMonitor.js` - Magnet链监听模块
- `src/bscHandler.js` - BSC链处理模块
- `src/db.js` - 数据管理模块
- `src/config.js` - 配置文件

## 安全建议

### 验证者密钥管理

- 使用环境变量或加密存储验证者私钥
- 考虑使用硬件钱包或HSM（硬件安全模块）

### 多签验证机制

- 设置至少3个独立验证者
- 配置桥接合约要求多数验证者确认（如2/3, 3/5）

### 监控和告警

- 实现异常交易监控
- 设置账户余额低告警
- 定期审计交易日志

