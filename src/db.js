/**
 * 数据库处理模块
 * 用于存储和检索交易记录
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

class TransactionDB {
  constructor(dbPath) {
    this.path = dbPath;
    this.pendingDeposits = [];     // Magnet -> BSC待处理存款
    this.processedDeposits = [];   // 已处理的存款
    this.pendingWithdrawals = [];  // BSC -> Magnet待处理提款
    this.processedWithdrawals = []; // 已处理的提款
    
    this.load();
  }
  
  // 加载数据
  load() {
    try {
      // 确保目录存在
      const dir = path.dirname(this.path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // 读取数据文件
      if (fs.existsSync(this.path)) {
        const data = JSON.parse(fs.readFileSync(this.path, 'utf8'));
        this.pendingDeposits = data.pendingDeposits || [];
        this.processedDeposits = data.processedDeposits || [];
        this.pendingWithdrawals = data.pendingWithdrawals || [];
        this.processedWithdrawals = data.processedWithdrawals || [];
        console.log(`数据库加载成功: ${this.processedDeposits.length} 已处理存款, ${this.pendingDeposits.length} 待处理存款`);
      } else {
        this.save(); // 创建新文件
      }
    } catch (error) {
      console.error('加载数据库失败:', error);
    }
  }
  
  // 保存数据
  save() {
    try {
      const data = {
        pendingDeposits: this.pendingDeposits,
        processedDeposits: this.processedDeposits,
        pendingWithdrawals: this.pendingWithdrawals,
        processedWithdrawals: this.processedWithdrawals
      };
      
      fs.writeFileSync(this.path, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('保存数据库失败:', error);
    }
  }
  
  // 检查存款是否已处理
  isProcessedDeposit(txHash) {
    return this.processedDeposits.some(tx => tx.magTxHash === txHash);
  }
  
  // 检查提款是否已处理
  isProcessedWithdrawal(txHash) {
    return this.processedWithdrawals.some(tx => tx.bscTxHash === txHash);
  }

  // 添加待处理存款
  addPendingDeposit(deposit) {
    this.pendingDeposits.push(deposit);
    this.save();
  }

  // 添加已处理存款
  addProcessedDeposit(deposit) {
    // 确保查询字段存在
    const normalizedDeposit = {
      magTxHash: deposit.magTxHash,
      bscTxHash: deposit.bscTxHash || '',
      amount: deposit.amount || '',
      fee: deposit.fee || '0',
      recipient: deposit.recipient || '',
      status: deposit.status || 'success',
      timestamp: deposit.timestamp || Math.floor(Date.now() / 1000)
    };
    
    this.processedDeposits.push(normalizedDeposit);
    // 从待处理列表移除
    this.pendingDeposits = this.pendingDeposits.filter(d => d.txHash !== deposit.magTxHash);
    this.save();
  }

  // 添加待处理提款
  addPendingWithdrawal(withdrawal) {
    // 确保查询字段存在
    const normalizedWithdrawal = {
      txHash: withdrawal.txHash,
      from: withdrawal.from,
      destinationAddress: withdrawal.destinationAddress,
      amount: withdrawal.amount,
      fee: withdrawal.fee || '0',
      timestamp: withdrawal.timestamp, 
      status: withdrawal.status || 'pending',
      blockNumber: withdrawal.blockNumber || 0
    };
    
    this.pendingWithdrawals.push(normalizedWithdrawal);
    this.save();
  }

  // 添加已处理提款
  addProcessedWithdrawal(withdrawal) {
    // 确保查询字段存在
    const normalizedWithdrawal = {
      bscTxHash: withdrawal.bscTxHash,
      magTxHash: withdrawal.magTxHash || '',
      from: withdrawal.from,
      destinationAddress: withdrawal.destinationAddress,
      amount: withdrawal.amount,
      fee: withdrawal.fee || '0',
      status: withdrawal.status || 'success',
      timestamp: withdrawal.timestamp || Math.floor(Date.now() / 1000)
    };
    
    this.processedWithdrawals.push(normalizedWithdrawal);
    // 从待处理列表移除
    this.pendingWithdrawals = this.pendingWithdrawals.filter(w => w.txHash !== withdrawal.bscTxHash);
    this.save();
  }
  
  // 更新提款状态
  updateWithdrawalStatus(bscTxHash, status, magTxHash = null, extraInfo = {}) {
    // 先检查待处理提款列表
    const pendingIndex = this.pendingWithdrawals.findIndex(w => w.txHash === bscTxHash);
    
    if (pendingIndex !== -1) {
      // 更新待处理提款状态
      this.pendingWithdrawals[pendingIndex].status = status;
      if (magTxHash) {
        this.pendingWithdrawals[pendingIndex].magTxHash = magTxHash;
      }
      
      // 添加额外的信息（如多签钱包交易ID）
      if (extraInfo && Object.keys(extraInfo).length > 0) {
        this.pendingWithdrawals[pendingIndex].multiSigInfo = {
          ...this.pendingWithdrawals[pendingIndex].multiSigInfo,
          ...extraInfo,
          updatedAt: Math.floor(Date.now() / 1000)
        };
      }
      
      // 如果状态为'completed'，移至已处理列表
      if (status === 'completed') {
        const withdrawal = this.pendingWithdrawals[pendingIndex];
        this.addProcessedWithdrawal({
          bscTxHash: withdrawal.txHash,
          magTxHash: magTxHash || withdrawal.magTxHash || '',
          from: withdrawal.from,
          destinationAddress: withdrawal.destinationAddress,
          amount: withdrawal.amount,
          fee: withdrawal.fee,
          status: 'success',
          timestamp: Math.floor(Date.now() / 1000),
          multiSigInfo: withdrawal.multiSigInfo || extraInfo || {}
        });
      } else {
        this.save();
      }
      
      // 添加多签钱包信息到日志
      if (extraInfo && Object.keys(extraInfo).length > 0) {
        const infoString = Object.entries(extraInfo)
          .map(([key, value]) => `${key}: ${value}`)
          .join(', ');
        console.log(`已更新提款 ${bscTxHash} 状态为 ${status}, 额外信息: ${infoString}`);
      } else {
        console.log(`已更新提款 ${bscTxHash} 状态为 ${status}`);
      }
      return true;
    }
    
    console.warn(`未找到待处理提款: ${bscTxHash}`);
    return false;
  }
}

module.exports = new TransactionDB(config.db.path);
