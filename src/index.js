/**
 * 验证者服务主程序
 * 负责启动并协调Magnet POW链和BSC之间的跨链验证
 */

const magnetMonitor = require('./magnetMonitor');
const bscHandler = require('./bscHandler');
const db = require('./db');
const config = require('./config');

// 显示启动信息
console.log('=====================================');
console.log('Magnet POW <-> BSC 跨链桥验证者服务');
console.log('=====================================');
console.log(`运行配置:`);
console.log(`- Magnet POW RPC: ${config.magnet.rpc}`);
console.log(`- 监控地址: ${config.magnet.depositAddress}`);
console.log(`- BSC RPC: ${config.bsc.rpc}`);
console.log(`- 桥接合约: ${config.bsc.magBridgeAddress}`);
console.log(`- Token合约: ${config.bsc.magTokenAddress}`);
console.log(`- 必需确认数: ${config.requiredConfirmations}`);
console.log('=====================================');

// 启动验证者服务
async function start() {
  console.log('启动跨链桥验证者服务...');
  
  // 获取桥接状态
  try {
    const bridgeStatus = await bscHandler.getBridgeStatus();
    if (bridgeStatus) {
      console.log('当前桥接状态:');
      console.log(`- 状态: ${bridgeStatus.bridgeStatus}`);
      console.log(`- 费率: ${bridgeStatus.feeRate}`);
      console.log(`- 单笔限额: ${bridgeStatus.maxSingleTransaction} MAG`);
      console.log(`- 每日限额: ${bridgeStatus.dailyLimit} MAG`);
      console.log(`- 今日已用: ${bridgeStatus.dailyUsed} MAG`);
    }
  } catch (error) {
    console.warn('获取桥接状态失败:', error.message);
  }
  
  // 启动链监视器
  const magnetStarted = await magnetMonitor.start();
  const bscStarted = await bscHandler.start();
  
  if (!magnetStarted || !bscStarted) {
    console.error('启动链监视器失败，请检查网络连接和配置');
    process.exit(1);
  }
  
  // 设置事件处理
  // Magnet -> BSC 存款确认
  magnetMonitor.on('deposit-confirmed', async (deposit) => {
    console.log(`处理已确认的存款: ${deposit.txHash}`);
    await bscHandler.confirmDeposit(deposit);
  });
  
  // BSC -> Magnet 提款检测
  bscHandler.on('withdrawal-detected', async (withdrawal) => {
    console.log(`检测到提款请求: ${withdrawal.from} 请求提取 ${withdrawal.amount} MAG到 ${withdrawal.destinationAddress}`);
    console.log(`状态: ${withdrawal.status}, 费用: ${withdrawal.fee || '0'} MAG`);
    
    if (withdrawal.status === 'pending') {
      // 使用多签钱包自动处理提款请求
      if (config.magnet.multiSigAddress && config.magnet.multiSigAddress !== '0x0000000000000000000000000000000000000000') {
        console.log(`正在通过多签钱包处理提款请求...`);
        const result = await magnetMonitor.processWithdrawal(withdrawal);
        if (result) {
          console.log(`提款请求处理成功启动，等待其他验证者确认`);
        } else {
          console.log(`提款请求处理失败，请手动检查`);
        }
      } else {
        console.log('多签钱包未配置，需要手动在Magnet链上处理此提款');
      }
    } else if (withdrawal.status === 'failed') {
      console.log('提款请求失败，记录原因并通知管理员');
    }
  });
  
  // 定期检查桥接状态
  setInterval(async () => {
    try {
      const bridgeStatus = await bscHandler.getBridgeStatus();
      if (bridgeStatus && bridgeStatus.bridgeStatus === '暂停中') {
        console.log('警告: 桥接合约当前处于暂停状态，无法处理新的跨链请求');
      }
    } catch (error) {
      // 静默处理错误，避免日志过多
    }
  }, 300000); // 每5分钟检查一次
  
  console.log('验证者服务已完全启动');
  console.log('按 Ctrl+C 终止服务');
}

// 处理进程终止
process.on('SIGINT', () => {
  console.log('\n正在关闭验证者服务...');
  db.save(); // 保存最新状态
  console.log('数据已保存，服务已关闭');
  process.exit();
});

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
  db.save(); // 确保保存数据
});

// 处理未处理的Promise拒绝
process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason);
});

// 启动应用
start().catch(error => {
  console.error('启动验证者服务失败:', error);
  process.exit(1);
});
