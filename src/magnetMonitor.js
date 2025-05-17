/**
 * Magnet POW链监听模块
 * 负责监控Magnet链上的存款事件和处理提款请求
 */

const Web3 = require('web3');
const EventEmitter = require('events');
const config = require('./config');
const db = require('./db');
const MultiSigABI = require('./abis/MagnetMultiSigABI');

class MagnetMonitor extends EventEmitter {
  constructor() {
    super();
    this.web3 = new Web3(config.magnet.rpc);
    
    // 存款地址和多签钱包使用同一地址
    // 这增强了安全性，因为所有资金都由多签钱包保护
    this.depositAddress = config.magnet.depositAddress; // 这实际上是多签钱包地址
    
    // 设置账户
    if (config.magnet.privateKey) {
      this.account = this.web3.eth.accounts.privateKeyToAccount(config.magnet.privateKey);
      this.web3.eth.accounts.wallet.add(this.account);
    } else {
      console.warn('警告：Magnet验证者私钥未设置，将无法执行交易');
    }
    
    // 初始化多签钱包合约
    if (config.magnet.multiSigAddress) {
      this.multiSig = new this.web3.eth.Contract(MultiSigABI, config.magnet.multiSigAddress);
      console.log(`已连接到多签钱包合约: ${config.magnet.multiSigAddress}`);
    } else {
      console.warn('警告：Magnet多签钱包地址未设置，将无法自动处理提款请求');
    }
  }
  
  // 初始化监听器
  async start() {
    console.log('启动Magnet POW链监听...');
    
    try {
      // 测试连接
      const blockNumber = await this.web3.eth.getBlockNumber();
      console.log(`当前Magnet链区块高度: ${blockNumber}`);
      
      // 检查多签钱包状态
      if (this.multiSig) {
        try {
          const [owners, required] = await Promise.all([
            this.multiSig.methods.getOwners().call(),
            this.multiSig.methods.requiredConfirmations().call()
          ]);
          console.log(`多签钱包所有者: ${owners.length} 个`);
          console.log(`需要的确认数: ${required}`);
          
          // 检查当前账户是否为多签钱包的所有者
          if (this.account) {
            const isOwner = await this.multiSig.methods.isOwner(this.account.address).call();
            if (isOwner) {
              console.log(`当前验证者是多签钱包所有者`);
            } else {
              console.warn(`警告: 当前验证者不是多签钱包所有者，无法参与多签确认`);
            }
          }
        } catch (error) {
          console.error('检查多签钱包状态失败:', error.message);
        }
      }
      
      // 设置区块订阅（如果支持）或使用轮询
      this.startBlockPolling(blockNumber);
      
      // 启动待处理存款检查
      this.startPendingDepositCheck();
      
      // 启动待处理提款请求检查
      this.startPendingWithdrawalCheck();
      
      console.log('Magnet链监听服务已成功启动');
      return true;
    } catch (error) {
      console.error('启动Magnet链监听服务失败:', error);
      return false;
    }
  }
  
  /**
   * 处理提款请求 - 从BSC到Magnet链的提款
   * @param {Object} withdrawal 提款详情
   * @returns {Promise<boolean>} 是否处理成功
   */
  async processWithdrawal(withdrawal) {
    if (!this.multiSig || !this.account) {
      console.error('无法处理提款请求: 多签钱包未配置或验证者私钥未设置');
      return false;
    }
    
    try {
      // 将金额转换为可读格式后显示（但变量仍保持Wei单位）
      const readableAmount = this.web3.utils.fromWei(withdrawal.amount, 'ether');
      console.log(`处理提款请求: ${withdrawal.from} 请求提取 ${readableAmount} MAG 到 ${withdrawal.destinationAddress}`);
      
      // 检查提款请求是否已在本地处理
      if (db.isProcessedWithdrawal(withdrawal.txHash)) {
        console.log(`提款 ${withdrawal.txHash} 已在本地处理，跳过`);
        return true;
      }
      
      // 目标地址（从BSC跨链请求中解析）
      const destinationAddress = withdrawal.destinationAddress;
      
      // 验证目标地址格式
      if (!this.web3.utils.isAddress(destinationAddress)) {
        console.error(`目标地址 ${destinationAddress} 格式无效`);
        return false;
      }
      
      // 直接使用原始Wei金额，不再进行转换（因为从BSC事件接收的金额已经是Wei格式）
      const withdrawalAmount = withdrawal.amount;
      
      // 先检查多签钱包中是否已有该交易并已执行
      // 仅检查最近20个交易，提高效率
      // 这一步很重要，可以避免因数据不同步而导致重复处理
      const transactionCount = await this.multiSig.methods.transactionCount().call();
      const startIndex = Math.max(0, transactionCount - 20); // 只检查最近20个交易
      console.log(`交易总数: ${transactionCount}, 开始检查索引: ${startIndex}`);
      
      for (let i = transactionCount - 1; i >= startIndex; i--) { // 从最近的交易开始逆序检查
        const tx = await this.multiSig.methods.transactions(i).call();
        if (tx.destination.toLowerCase() === destinationAddress.toLowerCase() && 
            tx.value === withdrawalAmount && 
            tx.executed) {
          console.log(`发现已执行的匹配交易: ID=${i}，更新本地状态`);
          // 更新本地数据库状态
          db.updateWithdrawalStatus(withdrawal.txHash, 'completed');
          return true;
        }
      }
      
      // 检查多签钱包余额是否足够
      const walletBalance = await this.web3.eth.getBalance(config.magnet.multiSigAddress);
      
      // 比较余额（使用Wei单位进行实际比较）
      if (this.web3.utils.toBN(walletBalance).lt(this.web3.utils.toBN(withdrawalAmount))) {
        // 显示时转换为可读格式
        const readableWalletBalance = this.web3.utils.fromWei(walletBalance, 'ether');
        console.error(`多签钱包余额不足: ${readableWalletBalance} MAG < ${readableAmount} MAG`);
        return false;
      }
      
      // 检查是否已有提交的交易但尚未执行
      const txId = await this.findExistingTransaction(destinationAddress, withdrawalAmount);
      
      if (txId !== null) {
        // 有现有交易，确认它
        return await this.confirmExistingTransaction(txId, withdrawal);
      } else {
        // 没有现有交易，创建新交易
        return await this.createNewWithdrawalTransaction(destinationAddress, withdrawalAmount, withdrawal);
      }
    } catch (error) {
      console.error(`处理提款请求失败: ${withdrawal.txHash}`, error);
      return false;
    }
  }
  
  /**
   * 查找已有的针对特定目标和金额的交易
   * @param {string} destination 目标地址
   * @param {string} amount 金额
   * @returns {Promise<number|null>} 交易ID或null
   */
  async findExistingTransaction(destination, amount) {
    try {
      // 获取所有待处理交易
      const pendingTxIds = await this.multiSig.methods.getPendingTransactions().call();
      
      for (const txId of pendingTxIds) {
        const tx = await this.multiSig.methods.transactions(txId).call();
        
        // 检查目标地址和金额是否匹配
        if (tx.destination.toLowerCase() === destination.toLowerCase() && 
            tx.value === amount && 
            !tx.executed) {
          console.log(`找到匹配的待处理交易: ID=${txId}`);
          return txId;
        }
      }
      
      return null;
    } catch (error) {
      console.error('查找现有交易失败:', error);
      return null;
    }
  }
  
  /**
   * 确认已存在的交易
   * @param {number} txId 交易ID
   * @param {Object} withdrawal 提款详情
   * @returns {Promise<boolean>} 是否成功
   */
  async confirmExistingTransaction(txId, withdrawal) {
    try {
      // 先检查链上交易状态，确保它还没有被执行
      const currentTx = await this.multiSig.methods.transactions(txId).call();
      if (currentTx.executed) {
        console.log(`交易 ${txId} 已被其他验证者执行，更新本地状态`);
        db.updateWithdrawalStatus(withdrawal.txHash, 'completed');
        return true;
      }

      // 检查当前验证者是否已确认
      const alreadyConfirmed = await this.multiSig.methods.confirmations(txId, this.account.address).call();
      
      if (alreadyConfirmed) {
        console.log(`交易 ${txId} 已被当前验证者确认`);
        
        // 检查是否可以执行
        const canExecute = await this.multiSig.methods.isConfirmed(txId).call();
        if (canExecute) {
          // 再次确认交易还没有被执行
          const txStatus = await this.multiSig.methods.transactions(txId).call();
          if (txStatus.executed) {
            console.log(`交易 ${txId} 刚刚被其他验证者执行，更新本地状态`);
            db.updateWithdrawalStatus(withdrawal.txHash, 'completed');
            return true;
          }

          // 尝试执行交易
          console.log(`尝试执行交易 ${txId}`);
          
          try {
            const gas = await this.multiSig.methods.executeTransaction(txId).estimateGas({ from: this.account.address });
            const tx = await this.multiSig.methods.executeTransaction(txId).send({
              from: this.account.address,
              gas: Math.floor(gas * 1.2) // 增加20%的gas以确保交易成功
            });
            
            console.log(`交易执行成功: ${tx.transactionHash}`);
            
            // 更新数据库状态
            db.updateWithdrawalStatus(withdrawal.txHash, 'completed', tx.transactionHash);
            
            return true;
          } catch (execError) {
            // 如果执行失败，可能是其他验证者已执行
            console.error(`执行交易失败: ${execError.message}`);
            
            // 尝试再次查询交易状态
            const txAfterFailure = await this.multiSig.methods.transactions(txId).call();
            if (txAfterFailure.executed) {
              // 交易确实已由其他验证者执行
              console.log(`交易 ${txId} 已由其他验证者执行，更新本地状态`);
              db.updateWithdrawalStatus(withdrawal.txHash, 'completed');
              return true;
            }
            
            // 其他执行失败原因
            return false;
          }
        }
        
        return true; // 已确认但尚未达到执行条件
      }
      
      // 确认交易
      console.log(`确认交易 ${txId}`);
      try {
        const gas = await this.multiSig.methods.confirmTransaction(txId).estimateGas({ from: this.account.address });
        const tx = await this.multiSig.methods.confirmTransaction(txId).send({
          from: this.account.address,
          gas: Math.floor(gas * 1.2)
        });
        
        console.log(`交易确认成功: ${tx.transactionHash}`);
        
        // 更新本地交易状态
        db.updateWithdrawalStatus(withdrawal.txHash, 'pending', tx.transactionHash);
        
        // 确认后立即检查是否可以执行
        const canExecuteAfterConfirm = await this.multiSig.methods.isConfirmed(txId).call();
        if (canExecuteAfterConfirm) {
          console.log(`确认成功后发现交易可执行，立即执行`);
          return await this.confirmExistingTransaction(txId, withdrawal); // 递归调用来执行交易
        }
        
        return true;
      } catch (confirmError) {
        // 确认失败可能是因为已经确认过或交易已执行
        console.error(`确认交易失败: ${confirmError.message}`);
        
        // 检查交易是否已执行
        const txAfterError = await this.multiSig.methods.transactions(txId).call();
        if (txAfterError.executed) {
          console.log(`交易 ${txId} 已执行，更新本地状态`);
          db.updateWithdrawalStatus(withdrawal.txHash, 'completed');
          return true;
        }
        
        // 检查是否已确认过
        const confirmedAfterError = await this.multiSig.methods.confirmations(txId, this.account.address).call();
        if (confirmedAfterError) {
          console.log(`交易 ${txId} 已经被当前验证者确认过`);
          return true;
        }
        
        return false;
      }
    } catch (error) {
      console.error(`确认交易 ${txId} 失败:`, error);
      return false;
    }
  }
  
  /**
   * 创建新的提款交易
   * @param {string} destination 目标地址
   * @param {string} amount 金额
   * @param {Object} withdrawal 提款详情
   * @returns {Promise<boolean>} 是否成功
   */
  async createNewWithdrawalTransaction(destination, amount, withdrawal) {
    try {
      console.log(`创建新的提款交易: ${destination}, 金额: ${this.web3.utils.fromWei(amount, 'ether')} MAG`);
      
      // 再次检查是否已存在相同交易（可能在查询和提交之间被其他验证者创建）
      const existingTxId = await this.findExistingTransaction(destination, amount);
      if (existingTxId !== null) {
        console.log(`发现其他验证者刚刚创建了相同的交易 ID=${existingTxId}，将改为确认该交易`);
        return await this.confirmExistingTransaction(existingTxId, withdrawal);
      }
      
      // 再次检查多签钱包余额
      const walletBalance = await this.web3.eth.getBalance(config.magnet.multiSigAddress);
      if (this.web3.utils.toBN(walletBalance).lt(this.web3.utils.toBN(amount))) {
        console.error(`创建交易前再次检查: 多签钱包余额不足: ${this.web3.utils.fromWei(walletBalance, 'ether')} MAG < ${this.web3.utils.fromWei(amount, 'ether')} MAG`);
        return false;
      }
      
      // 记录详细信息
      console.log(`准备提交交易:
  目标: ${destination}
  金额: ${this.web3.utils.fromWei(amount, 'ether')} MAG
  来源: BSC链交易 ${withdrawal.txHash}`);
      
      try {
        // 提交新交易
        const gas = await this.multiSig.methods.submitTransaction(
          destination, amount, '0x' // 无调用数据
        ).estimateGas({ from: this.account.address });
        
        const gasPrice = await this.web3.eth.getGasPrice();
        console.log(`估算Gas: ${gas}, Gas价格: ${this.web3.utils.fromWei(gasPrice, 'gwei')} Gwei`);
        
        const tx = await this.multiSig.methods.submitTransaction(
          destination, amount, '0x'
        ).send({
          from: this.account.address,
          gas: Math.floor(gas * 1.2),
          gasPrice
        });
        
        console.log(`提款交易已提交: ${tx.transactionHash}`);
        
        // 获取交易ID (从事件中解析)
        let txId = null;
        if (tx.events && tx.events.Submission) {
          txId = tx.events.Submission.returnValues.transactionId;
          console.log(`新交易ID: ${txId}`);
          
          // 保存交易ID和响应信息
          const submissionEvent = tx.events.Submission;
          console.log(`提交事件:
  交易ID: ${submissionEvent.returnValues.transactionId}
  区块号: ${submissionEvent.blockNumber}
  时间戟: ${new Date().toISOString()}`);
          
          // 检查是否有自动确认
          const confirmations = await this.multiSig.methods.getConfirmationCount(txId).call();
          console.log(`当前确认数: ${confirmations}`);
          
          // 更新提款状态，包含多签钱包交易ID
          db.updateWithdrawalStatus(withdrawal.txHash, 'pending', tx.transactionHash, {
            multiSigTxId: txId,
            confirmations: parseInt(confirmations),
            timestamp: Math.floor(Date.now() / 1000)
          });
          
          // 检查是否可执行 (如果只需要1个确认)
          const canExecute = await this.multiSig.methods.isConfirmed(txId).call();
          if (canExecute) {
            console.log(`交易 ${txId} 已获得足够确认，尝试执行`);
            return await this.confirmExistingTransaction(txId, withdrawal);
          }
        } else {
          console.warn(`提交交易成功但未收到Submission事件，无法获取交易ID`);
          // 即使没有获取到交易ID仍然更新状态
          db.updateWithdrawalStatus(withdrawal.txHash, 'pending', tx.transactionHash);
        }
        
        return true;
      } catch (submitError) {
        console.error(`提交交易失败: ${submitError.message}`);
        
        // 交易可能失败的原因是同样的交易刚刚被提交
        // 再次检查是否已存在相同交易
        console.log(`检查是否已存在相同交易...`);
        const checkAgainTxId = await this.findExistingTransaction(destination, amount);
        if (checkAgainTxId !== null) {
          console.log(`找到相同交易 ID=${checkAgainTxId}，尝试确认`);
          return await this.confirmExistingTransaction(checkAgainTxId, withdrawal);
        }
        
        return false;
      }
    } catch (error) {
      console.error('创建新提款交易过程中出错:', error);
      return false;
    }
  }
  
  // 区块轮询（如果节点不支持websocket）
  async startBlockPolling(startBlock) {
    let lastCheckedBlock = startBlock;
    
    setInterval(async () => {
      try {
        const currentBlock = await this.web3.eth.getBlockNumber();
        
        if (currentBlock > lastCheckedBlock) {
          console.log(`检查Magnet区块 ${lastCheckedBlock + 1} 到 ${currentBlock}`);
          
          // 检查区块范围内的交易
          for (let i = lastCheckedBlock + 1; i <= currentBlock; i++) {
            await this.checkBlock(i);
          }
          
          lastCheckedBlock = currentBlock;
        }
      } catch (error) {
        console.error('Magnet区块轮询错误:', error);
      }
    }, 15000); // 每15秒检查一次
  }
  
  // 检查单个区块
  async checkBlock(blockNumber) {
    try {
      const block = await this.web3.eth.getBlock(blockNumber, true);
      
      if (block && block.transactions) {
        // 检查区块中的所有交易
        for (const tx of block.transactions) {
          // 检查交易是否发送到目标地址
          if (tx.to && tx.to.toLowerCase() === this.depositAddress.toLowerCase()) {
            console.log(`发现存款交易: ${tx.hash}`);
            
            // 添加到待处理存款列表
            await this.processPendingDeposit(tx, blockNumber);
          }
        }
      }
    } catch (error) {
      console.error(`检查区块 ${blockNumber} 失败:`, error);
    }
  }
  
  // 处理待确认的存款
  async processPendingDeposit(tx, blockNumber) {
    try {
      // 检查交易是否已处理
      if (db.isProcessedDeposit(tx.hash)) {
        console.log(`存款 ${tx.hash} 已处理，跳过`);
        return;
      }
      
      // 获取交易详情
      const txDetails = await this.web3.eth.getTransaction(tx.hash);
      const txReceipt = await this.web3.eth.getTransactionReceipt(tx.hash);
      
      // 检查交易状态
      if (!txReceipt || txReceipt.status !== true) {
        console.log(`存款交易 ${tx.hash} 状态异常，请手动检查`);
        return;
      }
      
      // 获取区块时间戳
      const block = await this.web3.eth.getBlock(blockNumber);
      const timestamp = block ? block.timestamp : Math.floor(Date.now() / 1000);
      
      // 添加到待处理列表
      db.addPendingDeposit({
        txHash: tx.hash,
        from: tx.from,
        value: tx.value,
        blockNumber: blockNumber,
        timestamp: timestamp,
        gasUsed: txReceipt.gasUsed || 0,
        status: 'pending' // 初始状态
      });
      
      console.log(`添加待处理存款: ${tx.hash}, 时间: ${new Date(timestamp * 1000).toISOString()}`);
    } catch (error) {
      console.error('处理待确认存款失败:', error);
    }
  }
  
  // 定期检查待处理存款
  startPendingDepositCheck() {
    setInterval(async () => {
      await this.checkPendingDeposits();
    }, 60000); // 每分钟检查一次
  }
  
  // 定期检查待处理提款请求
  startPendingWithdrawalCheck() {
    if (!this.multiSig || !this.account) {
      console.warn('多签钱包未配置或验证者私钥未设置，无法自动处理提款');
      return;
    }
    
    setInterval(async () => {
      try {
        if (db.pendingWithdrawals.length === 0) {
          return;
        }
        
        console.log(`检查 ${db.pendingWithdrawals.length} 个待处理提款...`);
        
        // 获取多签钱包余额
        const walletBalance = await this.web3.eth.getBalance(config.magnet.multiSigAddress);
        console.log(`多签钱包当前余额: ${this.web3.utils.fromWei(walletBalance, 'ether')} MAG`);
        
        // 检查并处理每个待处理提款
        for (const withdrawal of db.pendingWithdrawals) {
          if (withdrawal.status === 'pending') {
            await this.processWithdrawal(withdrawal);
          }
        }
      } catch (error) {
        console.error('检查待处理提款失败:', error);
      }
    }, 120000); // 每2分钟检查一次
  }
  
  // 检查交易确认状态
  async checkPendingDeposits() {
    try {
      if (db.pendingDeposits.length === 0) {
        return;
      }
      
      console.log(`检查 ${db.pendingDeposits.length} 个待处理存款...`);
      const currentBlock = await this.web3.eth.getBlockNumber();
      
      for (const deposit of db.pendingDeposits) {
        // 检查确认数
        const confirmations = currentBlock - deposit.blockNumber;
        
        if (confirmations >= config.requiredConfirmations) {
          console.log(`交易 ${deposit.txHash} 已确认 (${confirmations} 确认数)`);
          
          // 计算费用（如果当前未知，可由BSC对应模块计算）
          const estimatedFee = '0'; // 在这里我们赋值为0，因为实际费用由BSC合约计算
          
          // 发送到BSC进行确认 - 通过事件通知
          this.emit('deposit-confirmed', {
            txHash: deposit.txHash,
            from: deposit.from,
            value: deposit.value,
            confirmations,
            fee: estimatedFee,
            status: 'pending' // 初始状态设置为 pending，稍后由BSC处理后更新
          });
          
          // 添加日志
          console.log(`已发送存款确认请求，待BSC处理: ${deposit.txHash}`);
        }
      }
    } catch (error) {
      console.error('检查待处理存款失败:', error);
    }
  }
}

module.exports = new MagnetMonitor();
