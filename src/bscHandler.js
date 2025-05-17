/**
 * BSC链处理模块
 * 负责在BSC链上确认跨链交易并监听提款事件
 */

const Web3 = require('web3');
const EventEmitter = require('events');
const config = require('./config');
const db = require('./db');

// MAGBridge合约ABI
const MAGBridgeABI = [
  // 确认交易方法
  {
    "inputs": [
      { "internalType": "bytes32", "name": "txHash", "type": "bytes32" },
      { "internalType": "address", "name": "recipient", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" }
    ],
    "name": "confirmTransaction",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  // 已处理交易映射
  {
    "inputs": [
      { "internalType": "bytes32", "name": "", "type": "bytes32" }
    ],
    "name": "processedTransactions",
    "outputs": [
      { "internalType": "bool", "name": "", "type": "bool" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // 检查合约是否暂停
  {
    "inputs": [],
    "name": "paused",
    "outputs": [
      { "internalType": "bool", "name": "", "type": "bool" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // 费用百分比
  {
    "inputs": [],
    "name": "feePercentage",
    "outputs": [
      { "internalType": "uint256", "name": "", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // 最大交易限额
  {
    "inputs": [],
    "name": "maxTransactionAmount",
    "outputs": [
      { "internalType": "uint256", "name": "", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // 最小交易限额
  {
    "inputs": [],
    "name": "minTransactionAmount",
    "outputs": [
      { "internalType": "uint256", "name": "", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // 每日交易限额
  {
    "inputs": [],
    "name": "dailyTransactionLimit",
    "outputs": [
      { "internalType": "uint256", "name": "", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // 每日交易总额
  {
    "inputs": [],
    "name": "dailyTransactionTotal",
    "outputs": [
      { "internalType": "uint256", "name": "", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // 跨链转账事件
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "from", "type": "address" },
      { "indexed": true, "internalType": "address", "name": "to", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "amount", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "fee", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "timestamp", "type": "uint256" },
      { "indexed": false, "internalType": "bytes32", "name": "txHash", "type": "bytes32" },
      { "indexed": false, "internalType": "uint256", "name": "confirmations", "type": "uint256" },
      { "indexed": false, "internalType": "string", "name": "status", "type": "string" }
    ],
    "name": "CrossChainTransfer",
    "type": "event"
  },
  // 跨链提款事件
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "from", "type": "address" },
      { "indexed": false, "internalType": "string", "name": "destinationAddress", "type": "string" },
      { "indexed": false, "internalType": "uint256", "name": "amount", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "fee", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "timestamp", "type": "uint256" },
      { "indexed": false, "internalType": "string", "name": "status", "type": "string" }
    ],
    "name": "CrossChainWithdraw",
    "type": "event"
  },
  // 费用收取事件
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "from", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "amount", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "fee", "type": "uint256" },
      { "indexed": true, "internalType": "bytes32", "name": "txHash", "type": "bytes32" },
      { "indexed": false, "internalType": "string", "name": "operationType", "type": "string" }
    ],
    "name": "FeeCollected",
    "type": "event"
  }
];

class BSCHandler extends EventEmitter {
  constructor() {
    super();
    // 明确使用HttpProvider连接BSC节点
    this.web3 = new Web3(new Web3.providers.HttpProvider(config.bsc.rpc));
    
    // 设置账户
    if (config.bsc.privateKey) {
      this.account = this.web3.eth.accounts.privateKeyToAccount(config.bsc.privateKey);
      this.web3.eth.accounts.wallet.add(this.account);
    } else {
      console.warn('警告：BSC验证者私钥未设置，将无法执行交易');
    }
    
    // 初始化合约实例
    this.magBridge = new this.web3.eth.Contract(MAGBridgeABI, config.bsc.magBridgeAddress);
  }
  
  /**
   * 启动BSC链监听
   * @param {boolean} scanPastBlocks - 是否扫描过去的区块，默认为true
   * @param {number} blocksToScan - 要扫描的过去区块数，默认为100
   */
  async start(scanPastBlocks = true, blocksToScan = 300) {
    try {
      console.log('启动BSC链监听...');
      
      // 获取当前区块号
      const currentBlock = await this.web3.eth.getBlockNumber();
      console.log(`当前BSC链区块高度: ${currentBlock}`);
      
      // 如果需要扫描过去的区块
      let startBlock = currentBlock;
      if (scanPastBlocks) {
        startBlock = Math.max(0, currentBlock - blocksToScan);
        console.log(`将检索过去 ${blocksToScan} 个区块 (${startBlock} 到 ${currentBlock})的事件...`);
      }
      
      // 启动区块轮询，从指定区块开始
      this.startBlockPolling(startBlock);
      
      console.log('BSC链监听服务已成功启动');
      return true;
    } catch (error) {
      console.error('启动BSC链监听服务失败:', error);
      throw error;
    }
  }
  
  // 处理提款事件
  async handleWithdrawEvent(event) {
    try {
      const { from, destinationAddress, amount, fee, timestamp, status } = event.returnValues;
      
      console.log(`检测到提款事件: ${from} 请求提取 ${this.web3.utils.fromWei(amount)} MAG 到 ${destinationAddress}`);
      console.log(`费用: ${this.web3.utils.fromWei(fee)} MAG, 状态: ${status}`);
      
      // 检查是否已处理
      if (db.isProcessedWithdrawal(event.transactionHash)) {
        console.log(`提款 ${event.transactionHash} 已处理，跳过`);
        return;
      }
      
      // 记录待处理提款
      db.addPendingWithdrawal({
        txHash: event.transactionHash,
        from,
        destinationAddress,
        amount,
        fee,
        timestamp,
        status,
        blockNumber: event.blockNumber
      });
      
      // 发送事件通知
      this.emit('withdrawal-detected', {
        txHash: event.transactionHash,
        from,
        destinationAddress,
        amount,
        fee,
        status
      });
    } catch (error) {
      console.error('处理提款事件失败:', error);
    }
  }
  
  // 确认Magnet上的存款到BSC
  async confirmDeposit(deposit) {
    try {
      console.log(`确认存款到BSC: ${deposit.txHash}`);
      
      // 检查合约是否暂停
      const isPaused = await this.magBridge.methods.paused().call();
      if (isPaused) {
        console.log(`桥接合约当前处于暂停状态，无法确认交易`);  
        return false;
      }
      
      // 检查交易是否已处理
      const txHashBytes32 = this.web3.utils.keccak256(deposit.txHash);
      const isProcessed = await this.magBridge.methods.processedTransactions(txHashBytes32).call();
      
      if (isProcessed) {
        console.log(`存款 ${deposit.txHash} 已在BSC上处理，跳过`);
        
        // 更新数据库
        db.addProcessedDeposit({
          magTxHash: deposit.txHash,
          bscTxHash: '', // 已处理但不知道BSC交易哈希
          timestamp: Math.floor(Date.now() / 1000)
        });
        
        return true;
      }
      
      // 检查最近的交易，看是否其他验证者最近确认了这笔交易
      // 这对无共享数据库情况下非常重要
      try {
        const latestBlockNumber = await this.web3.eth.getBlockNumber();
        const blocksToCheck = 100; // 检查最近100个区块
        const startBlock = Math.max(0, latestBlockNumber - blocksToCheck);
        
        console.log(`检查最近的区块事件，从 ${startBlock} 到 ${latestBlockNumber}...`);
        
        // 这里假设合约中有TransactionConfirmed事件
        // 如果合约中没有该事件，可以根据实际情况修改
        const recentEvents = await this.magBridge.getPastEvents('allEvents', {
          fromBlock: startBlock,
          toBlock: 'latest'
        });
        
        // 过滤出与当前存款相关的事件
        const relevantEvents = recentEvents.filter(event => {
          // 检查事件中的参数是否包含当前存款的哈希
          if (event.returnValues && event.event !== 'allEvents') {
            // 简单地过滤出可能与当前交易相关的事件
            // 可以使用JSON.stringify检查事件中是否包含交易哈希
            const eventString = JSON.stringify(event.returnValues);
            return eventString.includes(txHashBytes32) || 
                   eventString.includes(deposit.txHash.replace('0x', '')) || 
                   eventString.includes(deposit.txHash);
          }
          return false;
        });
        
        if (relevantEvents.length > 0) {
          console.log(`发现 ${relevantEvents.length} 个与当前存款相关的事件`);
          
          // 检查是否有成功的确认交易
          for (const event of relevantEvents) {
            console.log(`发现相关交易: ${event.event}, txHash: ${event.transactionHash}`);
            
            // 更新数据库状态
            db.addProcessedDeposit({
              magTxHash: deposit.txHash,
              bscTxHash: event.transactionHash,
              timestamp: Math.floor(Date.now() / 1000),
              note: `由其他验证者确认`
            });
            
            console.log(`存款 ${deposit.txHash} 已被其他验证者处理，跳过`);
            return true;
          }
        } else {
          console.log(`没有发现相关的交易事件，继续处理`);
        }
      } catch (eventError) {
        console.warn(`检查最近交易事件失败: ${eventError.message}，继续处理`);
      }
      
      // 获取限额信息
      const maxAmount = await this.magBridge.methods.maxTransactionAmount().call();
      const dailyLimit = await this.magBridge.methods.dailyTransactionLimit().call();
      const dailyTotal = await this.magBridge.methods.dailyTransactionTotal().call();
      
      // 检查交易限额
      if (this.web3.utils.toBN(deposit.value).gt(this.web3.utils.toBN(maxAmount))) {
        console.error(`交易金额超过单笔最大限额：${this.web3.utils.fromWei(deposit.value)} > ${this.web3.utils.fromWei(maxAmount)}`);
        return false;
      }
      
      // 检查每日限额
      if (this.web3.utils.toBN(dailyTotal).add(this.web3.utils.toBN(deposit.value)).gt(this.web3.utils.toBN(dailyLimit))) {
        console.error(`交易会超过每日限额：当前总额 ${this.web3.utils.fromWei(dailyTotal)}，本次交易 ${this.web3.utils.fromWei(deposit.value)}，每日限额 ${this.web3.utils.fromWei(dailyLimit)}`);
        return false;
      }
      
      // 准备交易数据
      const recipient = deposit.from; // 接收者与发送者相同，也可以自定义映射
      const amount = deposit.value; // 金额与存款相同
      
      // 检查验证者是否有足够的BSC余额来支付Gas
      if (this.account) {
        const balance = await this.web3.eth.getBalance(this.account.address);
        if (this.web3.utils.toBN(balance).lt(this.web3.utils.toBN('1000000000000000'))) { // 0.001 BNB
          console.error(`验证者BSC余额不足，无法支付Gas费用`);
          return false;
        }
      }
      
      // 调用桥接合约确认交易
      console.log(`发送确认交易: 哈希=${txHashBytes32.substring(0, 10)}..., 接收者=${recipient}, 金额=${amount}`);
      
      const tx = await this.magBridge.methods.confirmTransaction(
        txHashBytes32,
        recipient,
        amount
      ).send({ 
        from: this.account.address,
        gas: 300000,
        gasPrice: await this.web3.eth.getGasPrice()
      });
      
      console.log(`BSC确认交易发送成功: ${tx.transactionHash}`);
      
      // 更新数据库
      db.addProcessedDeposit({
        magTxHash: deposit.txHash,
        bscTxHash: tx.transactionHash,
        timestamp: Math.floor(Date.now() / 1000)
      });
      
      return true;
    } catch (error) {
      console.error(`确认存款到BSC失败: ${deposit.txHash}`, error);
      return false;
    }
  }
  
  /**
   * 启动区块轮询处理
   * @param {number} startBlock - 开始轮询的区块号
   */
  async startBlockPolling(startBlock) {
    // 存储最后检查的区块号
    this.lastCheckedBlock = startBlock || await this.web3.eth.getBlockNumber() - 10;
    console.log(`从BSC区块 ${this.lastCheckedBlock} 开始轮询`);
    
    // 创建事件主题哈希，用于后续匹配
    // 与合约中定义的事件结构完全匹配
    this.withdrawEventTopic = this.web3.utils.sha3('CrossChainWithdraw(address,string,uint256,uint256,uint256,string)');
    this.transferEventTopic = this.web3.utils.sha3('CrossChainTransfer(address,address,uint256,uint256,uint256,bytes32,uint256,string)');
    console.log('事件哈希设置完成，监听提款事件主题:', this.withdrawEventTopic);
    
    // 首先检查是否需要处理历史区块（大批量处理）
    const currentBlock = await this.web3.eth.getBlockNumber();
    if (currentBlock - this.lastCheckedBlock > 50) {
      console.log(`检测到大量历史区块需要处理: ${this.lastCheckedBlock} 到 ${currentBlock}`);
      await this.processHistoricalBlocks(this.lastCheckedBlock, currentBlock);
    }
    
    // 开始定时轮询新区块
    setInterval(async () => {
      try {
        const currentBlock = await this.web3.eth.getBlockNumber();
        
        if (currentBlock > this.lastCheckedBlock) {
          // 计算要处理的区块范围，一次最多处理20个区块(以减少常规轮询的负荷)
          const fromBlock = this.lastCheckedBlock + 1;
          const toBlock = Math.min(currentBlock, fromBlock + 19);
          console.log(`检查BSC区块 ${fromBlock} 到 ${toBlock} 的事件`);
          
          // 逐个处理区块
          for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber++) {
            await this.processBlockByNumber(blockNumber);
          }
          
          // 更新最后检查的区块
          this.lastCheckedBlock = toBlock;
        }
      } catch (error) {
        console.error('BSC区块轮询错误:', error);
      }
    }, 15000); // 每15秒检查一次
  }
  
  /**
   * 处理历史区块 - 针对大量区块的批量处理
   * @param {number} fromBlock - 起始区块
   * @param {number} toBlock - 结束区块
   */
  async processHistoricalBlocks(fromBlock, toBlock) {
    try {
      // 分批处理，每批大幅减小到10个区块，以防止速率限制
      const batchSize = 10;
      let processedCount = 0;
      
      for (let start = fromBlock; start <= toBlock; start += batchSize) {
        const end = Math.min(toBlock, start + batchSize - 1);
        console.log(`批量处理历史区块 ${start} 到 ${end}...`);
        
        // 串行处理区块，而不是并行，以避免速率限制
        for (let blockNumber = start; blockNumber <= end; blockNumber++) {
          try {
            await this.processBlockByNumber(blockNumber);
            processedCount++;
            
            // 每处理一个区块后等待300ms，以防止速率限制
            await new Promise(resolve => setTimeout(resolve, 300));
          } catch (blockError) {
            console.error(`处理区块 ${blockNumber} 时出错，将等待5秒后重试`, blockError);
            // 遇到速率限制错误时，等待5秒
            await new Promise(resolve => setTimeout(resolve, 5000));
            // 重新处理当前区块，通过减少blockNumber实现
            blockNumber--;
          }
        }
        
        console.log(`已完成 ${processedCount}/${toBlock - fromBlock + 1} 个历史区块的处理`);
        
        // 更新最后检查的区块
        this.lastCheckedBlock = end;
        
        // 每批区块处理完成后等待500ms，避免API请求过于频繁
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      console.log(`历史区块处理完成，共处理 ${processedCount} 个区块`);
    } catch (error) {
      console.error('处理历史区块时出错:', error);
      // 出错后，仍然更新lastCheckedBlock，避免重复处理
      this.lastCheckedBlock = toBlock;
    }
  }
  
  /**
   * 处理单个区块
   * @param {number} blockNumber - 要处理的区块号
   * @param {number} retryCount - 重试计数，默认为0
   */
  async processBlockByNumber(blockNumber, retryCount = 0) {
    try {
      // 使用轻量级方式获取区块信息，不包含详细交易
      const blockHeader = await this.web3.eth.getBlock(blockNumber, false);
      
      if (!blockHeader) {
        console.log(`区块 ${blockNumber} 不存在或没有被确认`);
        return;
      }
      
      // 获取与我们合约相关的交易收据(按合约地址过滤)
      const receipts = await this.getContractTransactionReceipts(blockNumber);
      
      if (receipts && receipts.length > 0) {
        console.log(`在区块 ${blockNumber} 中找到 ${receipts.length} 笔相关交易`);
        for (const receipt of receipts) {
          try {
            await this.processTransactionReceipt(receipt, blockHeader.timestamp);
          } catch (receiptError) {
            console.error(`处理区块 ${blockNumber} 中的交易 ${receipt.transactionHash} 时出错:`, receiptError);
            // 继续处理下一笔交易，不让一笔交易的错误影响整个区块处理
          }
        }
      }
    } catch (error) {
      console.error(`处理区块 ${blockNumber} 时出错:`, error);
      
      // 检查是否为速率限制错误
      if (error.message && error.message.includes('Rate limit reached') && retryCount < 3) {
        const waitTime = (retryCount + 1) * 5000; // 递增等待时间: 5秒, 10秒, 15秒
        console.log(`遇到速率限制，将在 ${waitTime/1000} 秒后重试区块 ${blockNumber}，这是第 ${retryCount + 1} 次重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return this.processBlockByNumber(blockNumber, retryCount + 1);
      }
    }
  }
  
  
  // 获取与我们合约相关的交易收据
  async getContractTransactionReceipts(blockNumber) {
    try {
      // 直接获取区块
      const block = await this.web3.eth.getBlock(blockNumber, false);
      if (!block || !block.hash) return [];
      if (!block || !block.transactions || block.transactions.length === 0) return [];
      
      const receipts = [];
      
      // 对每个交易哈希获取收据
      for (const txHash of block.transactions) {
        try {
          const receipt = await this.web3.eth.getTransactionReceipt(txHash);
          
          // 只处理与我们合约相关的交易
          if (receipt && receipt.to && receipt.to.toLowerCase() === this.magBridge.options.address.toLowerCase()) {
            receipts.push(receipt);
          }
        } catch (error) {
          console.error(`获取交易收据出错 ${txHash}:`, error);
        }
      }
      
      return receipts;
    } catch (error) {
      console.error(`获取区块 ${blockNumber} 交易出错:`, error);
      return [];
    }
  }
  
  // 处理交易收据
  async processTransactionReceipt(receipt, blockTimestamp) {
    if (!receipt || !receipt.logs) return;
    
    // 遍历所有日志，查找我们感兴趣的事件
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === this.magBridge.options.address.toLowerCase()) {
        // 检查是否为提款事件
        if (log.topics[0] === this.withdrawEventTopic) {
          await this.processWithdrawEventLog(log, receipt, blockTimestamp);
        }
        // 检查是否为转账事件
        else if (log.topics[0] === this.transferEventTopic) {
          await this.processTransferEventLog(log, receipt, blockTimestamp);
        }
      }
    }
  }
  
  // 处理提款事件日志
  async processWithdrawEventLog(log, receipt, timestamp) {
    try {
      // 解码日志数据 - 从topics中获取indexed参数
      const from = this.web3.eth.abi.decodeParameter('address', log.topics[1]);
      
      // 从data中解码非indexed参数
      const data = this.web3.eth.abi.decodeParameters(
        ['string', 'uint256', 'uint256', 'uint256', 'string'], 
        log.data
      );
      
      const destinationAddress = data[0];
      const amount = data[1];
      const fee = data[2];
      const eventTimestamp = data[3]; 
      const status = data[4];
      
      console.log(`检测到提款事件: 交易=${receipt.transactionHash}, 用户=${from}, 目标地址=${destinationAddress}, 金额=${this.web3.utils.fromWei(amount)} MAG`);
      
      // 构造事件对象，类似于web3.js的事件格式，确保字段名与handleWithdrawEvent函数中期望的一致
      const event = {
        returnValues: {
          from: from,
          destinationAddress: destinationAddress,
          amount: amount,
          fee: fee,
          timestamp: eventTimestamp,
          status: status
        },
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber ? receipt.blockNumber.toString() : '0'
      };
      
      // 调用原有的事件处理函数
      await this.handleWithdrawEvent(event);
    } catch (error) {
      console.error('处理提款事件日志出错:', error);
    }
  }
  
  // 处理转账事件日志
  async processTransferEventLog(log, receipt, timestamp) {
    try {
      // 解码日志数据
      const data = this.web3.eth.abi.decodeParameters(
        ['address', 'address', 'uint256', 'uint256', 'bytes32', 'string'],
        log.data
      );
      
      const from = data[0];
      const to = data[1];
      const amount = data[2];
      const fee = data[3];
      const txHash = data[4];
      const status = data[5];
      
      console.log(`跨链转账: ${from} -> ${to}, 金额: ${this.web3.utils.fromWei(amount)}, 状态: ${status}`);
      
      if (status === 'success') {
        // 将成功的交易记录到数据库
        const magnetTxHash = this.web3.utils.toHex(txHash).replace('0x', '');
        db.addProcessedDeposit({
          magTxHash: magnetTxHash,
          bscTxHash: receipt.transactionHash,
          amount: amount,
          fee: fee,
          recipient: to,
          status: status,
          timestamp: Math.floor(timestamp || Date.now() / 1000)
        });
      }
    } catch (error) {
      console.error('处理转账事件日志出错:', error);
    }
  }
  
  // 获取桥接状态信息
  async getBridgeStatus() {
    try {
      const [feePercentage, maxAmount, minAmount, dailyLimit, dailyTotal, isPaused] = await Promise.all([
        this.magBridge.methods.feePercentage().call(),
        this.magBridge.methods.maxTransactionAmount().call(),
        this.magBridge.methods.minTransactionAmount().call(),
        this.magBridge.methods.dailyTransactionLimit().call(),
        this.magBridge.methods.dailyTransactionTotal().call(),
        this.magBridge.methods.paused().call()
      ]);
      
      return {
        feeRate: `${feePercentage / 100}%`,
        maxSingleTransaction: this.web3.utils.fromWei(maxAmount),
        minSingleTransaction: this.web3.utils.fromWei(minAmount),
        dailyLimit: this.web3.utils.fromWei(dailyLimit),
        dailyUsed: this.web3.utils.fromWei(dailyTotal),
        bridgeStatus: isPaused ? "暂停中" : "运行中"
      };
    } catch (error) {
      console.error('获取桥接状态信息失败:', error);
      return null;
    }
  }
}

module.exports = new BSCHandler();
