# Magnet-BSC 跨链桥验证者服务

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

该验证者服务用于实现 Magnet POW 区块链与 BSC (币安智能链) 之间的安全、可靠的资产跨链转移。除了保证交易可靠性和安全性外，该服务也采用了多重验证机制来防止幺灵攻击和回滚攻击。

## 主要功能

- **双向跨链支持**: 同时支持 Magnet -> BSC 和 BSC -> Magnet 的资产转移
- **高效区块扫描**: 实现了高效的区块轮询机制，兼容各种 RPC 节点限制
- **注意功能**: 兼容节点 getPastEvents 封锁问题，自动切换适配方案
- **多重验证机制**: 通过多个验证者共同确认交易，最大程度保障资金安全
- **随机延迟策略**: 智能处理验证者充突问题，避免重复处理交易
- **本地事件缓存**: 实现事件本地缓存，减少对节点的过度查询
- **异常恢复机制**: 容错处理和自动重试机制确保服务稳定性

## 系统要求与安装

### 前置条件

- **Node.js**: v14.0.0 或更高版本
- **Web3.js**: v1.5.0 或更高版本
- **区块链访问**: 
  - Magnet POW 链的稳定 RPC 访问
  - BSC 测试链或主网的 RPC 访问
- **智能合约**: 已部署并配置好的 MAGToken 和 MAGBridge 智能合约

### 安装步骤

1. 克隆本仓库

```bash
git clone https://github.com/your-username/Validator-service.git
cd Validator-service
```

2. 安装项目依赖

```bash
npm install
```

3. 创建并配置环境变量

```bash
cp .env.example .env
```

4. 编辑 `.env` 文件，填写必要的配置信息：

```plaintext
# Magnet POW链配置
MAGNET_RPC_URL=https://node1.magnetchain.xyz        # Magnet链RPC节点地址
MAGNET_DEPOSIT_ADDRESS=0xaC1F64cE7c768B5F6C19A352Bf9Cf313A26528D4  # 跨链桥存款地址
MAGNET_VALIDATOR_KEY=your_private_key_here          # 验证者私钥(勿上传GitHub!)

# BSC测试网配置
BSC_RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545/  # BSC测试网RPC地址
BSC_VALIDATOR_KEY=your_private_key_here             # BSC验证者私钥(勿上传GitHub!)
MAG_TOKEN_ADDRESS=0xd95fc74a2a6C7ea18B4C0eEfb3592E6B9c5a552D  # MAG代币合约地址
MAG_BRIDGE_ADDRESS=0xDc1f6e4b840F8E807B03aAA5B940B8Db73Eafc70  # 跨链桥合约地址

# 应用配置
DB_PATH=./db/transactions.json                      # 本地交易数据库存储路径
LOG_LEVEL=info                                      # 日志级别(debug/info/warn/error)
CONFIRMATIONS_REQUIRED=12                          # 所需确认数
```

5. 创建数据库目录

```bash
mkdir -p db
touch db/transactions.json
echo '{}' > db/transactions.json
```

## 使用方法

### 启动验证者服务

开发环境启动（带热重载）：

```bash
npm run dev
```

生产环境启动：

```bash
npm start
```

### 测试验证者运行状态

检查服务启动后的日志：

```bash
npm run logs
```

检测验证者核心功能：

```bash
npm run test:basic
```

### 服务器部署

推荐使用 Screen 或 PM2 进行生产环境部署以确保服务的连续运行。

**使用 Screen 部署（推荐）：**

```bash
# 创建新的 screen 会话
screen -S validator-service

# 在 screen 会话中启动服务
npm start

# 切出 screen会话(按 Ctrl+A 然后按 D)

# 重新连接到会话
screen -r validator-service
```

**或使用 PM2 部署：**

```bash
# 安装 PM2
npm install -g pm2

# 启动验证者服务
pm2 start src/index.js --name "magnet-bsc-validator"

# 查看日志
pm2 logs magnet-bsc-validator

# 设置开机自启
pm2 save
pm2 startup
```

## 工作原理

### Magnet -> BSC 跨链流程

1. 用户在 Magnet POW 链上发送 MAG 到跨链桥指定存款地址 (`0xaC1F64cE7c768B5F6C19A352Bf9Cf313A26528D4`)
2. 验证者服务通过区块轮询监测到存款交易，并等待至少 12 个区块确认(防止链重组)
3. 确认后，验证者使用相应私钥在 BSC 上调用 MAGBridge 合约的 `confirmTransaction` 方法
4. 多重验证者机制确保至少 N/M 个验证者提交同一交易的确认
5. 达到阈值后，MAGBridge 合约调用 MAGToken 合约的 `mint` 方法铨造代币给用户

### BSC -> Magnet 跨链流程

1. 用户在 BSC 上调用 MAGBridge 合约的 `withdraw` 方法发起提款请求，指定 Magnet 链上的接收地址
2. BSC 智能合约锁定/销毁用户的 MAG 代币，并触发 `CrossChainWithdraw` 事件
3. 验证者服务通过区块轮询检测到提款事件，并记录到本地数据库
4. 验证者根据事件信息，在 Magnet 链上处理转账操作，将 MAG 发送到用户指定的地址
5. 交易完成后更新本地数据库状态，标记提款请求为已处理

## 安全与运维注意事项

### 安全措施

- **私钥管理**: 绝不在代码中明文存储验证者私钥，建议使用环境变量或加密存储
- **多重认证**: 服务器访问应配置双因素认证(2FA)和 IP 白名单
- **防火墙配置**: 仅开放必要端口，限制 SSH 访问来源
- **日志审计**: 定期检查服务日志以发现异常行为

### 运维建议

- **资源监控**: 确保验证者账户始终有足够的 BNB 支付 Gas 费用，设置余额告警
- **节点冗余**: 建议部署至少 3 个验证者节点，使用不同的托管服务商和网络环境
- **数据备份**: 至少每日自动备份数据库文件(`./db/transactions.json`)并存储在多个安全的位置
- **更新维护**: 定期更新依赖包和服务端软件以修复安全漏洞

## 升级与扩展功能

### 已实现的关键功能

- **事件本地缓存机制** - 解决 BSC 节点对 `getPastEvents` 方法的限制
- **随机延迟策略** - 减少验证者之间的处理冲突
- **区块轮询机制** - 高效地采集链上事件和交易

### 建议添加的功能

- **Web 管理面板** - 开发用户友好的管理界面，实时监控跨链交易

## 文件结构与核心组件

### 主要文件

- `src/index.js` - 主程序入口，协调各模块之间的交互与事件处理
- `src/magnetMonitor.js` - Magnet 链监听模块，负责扫描和追踪 Magnet 链上的存款交易
- `src/bscHandler.js` - BSC 链处理模块，负责确认跨链交易并监听提款事件
- `src/db.js` - 数据管理模块，处理交易存储与查询，防止重复处理
- `src/config.js` - 配置文件，管理环境变量与系统设置

### 数据与日志

- `db/` - 存储交易数据的目录
  - `transactions.json` - 主要数据存储文件，记录已处理和待处理的交易
- `logs/` - 系统运行日志目录

### 核心技术特性

- **事件驱动架构** - 基于 Node.js 的 EventEmitter 实现的松耦合的模块交互
- **高效区块处理** - 优化的区块轮询机制压力测试可处理 1000+ TPS
- **智能恢复机制** - 系统超时自动重试与容错设计确保高稳定性

## 许可证

MIT License

Copyright (c) 2023-2025 

更多详情请参见 [LICENSE](LICENSE) 文件。

