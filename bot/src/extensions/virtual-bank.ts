import { MessageBot } from '@bhmb/bot'
import { config } from '../config'
import { enqueueShared } from '../shared-queue'
import { sendPrivateMessage } from '../private-message'
import { isAdmin as isAdminHelper } from './helpers/isAdmin'
import { normalizePlayerName } from './helpers/blockhead-mapping'
import { getQuestAPI as _getQuestAPI } from './helpers/extension-api'
import { QUESTS } from './quests/quest-data'

interface BankAccount {
  balance: number
  transactions: Transaction[]
  lastActive: number
}

interface Transaction {
  type: 'deposit' | 'withdraw' | 'transfer' | 'admin' | 'reward' | 'coinflip'
  amount: number
  from?: string
  to?: string
  reason?: string
  timestamp: number
}

MessageBot.registerExtension('virtual-bank', (ex) => {
  console.log('Virtual Bank System loaded!')
  
  // Helper functions
  const getAccount = (playerName: string): BankAccount => {
    const normalized = normalizePlayerName(playerName, 'upper')
    return ex.storage.get(`bank_${normalized}`, {
      balance: 0,
      transactions: [],
      lastActive: Date.now()
    })
  }
   
  const saveAccount = (playerName: string, account: BankAccount) => {
    const normalized = normalizePlayerName(playerName, 'upper')
    account.lastActive = Date.now()
    ex.storage.set(`bank_${normalized}`, account)
  }
  
  const addTransaction = (playerName: string, transaction: Transaction) => {
    const account = getAccount(playerName)
    account.transactions.push(transaction)
    // Keep only last 50 transactions
    if (account.transactions.length > 50) {
      account.transactions = account.transactions.slice(-50)
    }
    saveAccount(playerName, account)
  }
  
  const formatCoins = (amount: number): string => {
    return `${amount.toLocaleString()} Tokens`
  }

  const getQuestAPI = () => _getQuestAPI(ex.bot)
  
  // Commands
  ex.world.onMessage.sub(async ({ player, message }) => {
    const msg = message.trim()
    const args = msg.split(' ')
    const cmd = args[0].toLowerCase()
    
    // Check balance
    if (cmd === '/balance' || cmd === '/bal') {
      const account = getAccount(player.name)
      sendPrivateMessage(player.name, `${player.name}'s balance: ${formatCoins(account.balance)}`)
    }
    
    // Deposit (admin only - represents earning coins)
    if (cmd === '/deposit' && args.length >= 2) {
      if (!isAdminHelper(player.name)) {
        sendPrivateMessage(player.name, '❌ Only admins can deposit coins!')
        return
      }
      
      const targetPlayer = normalizePlayerName(args[1], 'upper')
      const amount = parseInt(args[2] || '0')
      
      if (amount <= 0 || isNaN(amount)) {
        sendPrivateMessage(player.name, '❌ Invalid amount!')
        return
      }
      
      await enqueueShared(() => {
        const account = getAccount(targetPlayer)
        account.balance += amount
        saveAccount(targetPlayer, account)

        addTransaction(targetPlayer, {
          type: 'admin',
          amount: amount,
          from: player.name,
          reason: 'Admin deposit',
          timestamp: Date.now()
        })

        sendPrivateMessage(player.name, `✅ Deposited ${formatCoins(amount)} to ${targetPlayer}`)
        sendPrivateMessage(player.name, `${targetPlayer}'s new balance: ${formatCoins(account.balance)}`)
      })
    }
    
    // Withdraw (admin only - represents spending coins)
    if (cmd === '/withdraw' && args.length >= 2) {
      if (!isAdminHelper(player.name)) {
        sendPrivateMessage(player.name, '❌ Only admins can withdraw coins!')
        return
      }
      
      const targetPlayer = normalizePlayerName(args[1], 'upper')
      const amount = parseInt(args[2] || '0')
      
      if (amount <= 0 || isNaN(amount)) {
        sendPrivateMessage(player.name, '❌ Invalid amount!')
        return
      }
      
      await enqueueShared(() => {
        const account = getAccount(targetPlayer)

        if (account.balance < amount) {
          sendPrivateMessage(player.name, `❌ ${targetPlayer} only has ${formatCoins(account.balance)}`)
          return
        }

        account.balance -= amount
        saveAccount(targetPlayer, account)

        addTransaction(targetPlayer, {
          type: 'admin',
          amount: -amount,
          to: player.name,
          reason: 'Admin withdrawal',
          timestamp: Date.now()
        })

        sendPrivateMessage(player.name, `✅ Withdrew ${formatCoins(amount)} from ${targetPlayer}`)
        sendPrivateMessage(player.name, `${targetPlayer}'s new balance: ${formatCoins(account.balance)}`)
      })
    }
    
    // Transfer between players
    if (cmd === '/pay' && args.length >= 3) {
      const targetPlayer = normalizePlayerName(args[1], 'upper')
      const amount = parseInt(args[2])
      
      if (amount <= 0 || isNaN(amount)) {
        sendPrivateMessage(player.name, '❌ Invalid amount!')
        return
      }
      
      if (targetPlayer === normalizePlayerName(player.name, 'upper')) {
        sendPrivateMessage(player.name, '❌ Cannot pay yourself!')
        return
      }
      
      await enqueueShared(() => {
        const senderAccount = getAccount(player.name)

        if (senderAccount.balance < amount) {
          sendPrivateMessage(player.name, `❌ Insufficient funds! You have ${formatCoins(senderAccount.balance)}`)
          return
        }

        const receiverAccount = getAccount(targetPlayer)

        // Transfer
        senderAccount.balance -= amount
        receiverAccount.balance += amount

        saveAccount(player.name, senderAccount)
        saveAccount(targetPlayer, receiverAccount)

        addTransaction(player.name, {
          type: 'transfer',
          amount: -amount,
          to: targetPlayer,
          timestamp: Date.now()
        })

        addTransaction(targetPlayer, {
          type: 'transfer',
          amount: amount,
          from: player.name,
          timestamp: Date.now()
        })

        ex.bot.send(`✅ ${player.name} paid ${formatCoins(amount)} to ${targetPlayer}`)
      })
    }
    
    // Coin flip (house edge)
    if (cmd === '/cf' && args.length >= 2) {
      const amount = parseInt(args[1])
      if (amount <= 0 || isNaN(amount)) {
        sendPrivateMessage(player.name, '❌ Invalid amount!')
        return
      }
      if (amount > 1000) {
        sendPrivateMessage(player.name, '❌ Max coin flip is 1,000 Tokens.')
        return
      }

      await enqueueShared(() => {
        const account = getAccount(player.name)
        if (account.balance < amount) {
          sendPrivateMessage(player.name, `❌ Insufficient funds! You have ${formatCoins(account.balance)}`)
          return
        }

        const roll = Math.random()
        const won = roll < 0.45
        if (won) {
          const payout = amount 
          account.balance += payout
          saveAccount(player.name, account)
          addTransaction(player.name, {
            type: 'coinflip',
            amount: payout,
            reason: 'Coin flip win',
            timestamp: Date.now()
          })
          sendPrivateMessage(player.name, `${player.name} won ${formatCoins(payout)}! New balance: ${formatCoins(account.balance)}`)
        } else {
          account.balance -= amount
          saveAccount(player.name, account)
          addTransaction(player.name, {
            type: 'coinflip',
            amount: -amount,
            reason: 'Coin flip loss',
            timestamp: Date.now()
          })
          sendPrivateMessage(player.name, `${player.name} lost ${formatCoins(amount)}. New balance: ${formatCoins(account.balance)}`)
        }
      })
    }

    // View transaction history
    if (cmd === '/transactions' || cmd === '/history') {
      const account = getAccount(player.name)
      
      if (account.transactions.length === 0) {
        sendPrivateMessage(player.name, 'No transactions yet.')
        return
      }
      
      sendPrivateMessage(player.name, `Recent transactions for ${player.name}:`)
      let output = ''
      const recent = account.transactions.slice(-5).reverse()
      recent.forEach((tx, i) => {
        const sign = tx.amount >= 0 ? '+' : ''
        const date = new Date(tx.timestamp).toLocaleTimeString()
        
        let desc = ''
        if (tx.type === 'transfer' && tx.from) {
          desc = `from ${tx.from}`
        } else if (tx.type === 'transfer' && tx.to) {
          desc = `to ${tx.to}`
        } else if (tx.reason) {
          desc = tx.reason
        }
        
        output += `${i+1}. ${sign}${formatCoins(Math.abs(tx.amount))} ${desc} (${date})\n`
      })
      sendPrivateMessage(player.name, output)
    }
    
    // Leaderboard
    if (cmd === '/baltop' || cmd === '/leaderboard') {
      const allKeys = ex.storage.keys().filter(k => k.startsWith('bank_'))
      
      const balances: {name: string, balance: number}[] = []
      
      allKeys.forEach(key => {
        const playerName = key.replace('bank_', '')
        const account = getAccount(playerName)
        balances.push({ name: playerName, balance: account.balance })
      })
      
      balances.sort((a, b) => b.balance - a.balance)
      let topbals = ''
      sendPrivateMessage(player.name, 'Top 5 Richest Players:')
      balances.slice(0, 5).forEach((p, i) => {
        topbals += `${i+1}. ${p.name}: ${formatCoins(p.balance)}\n`
      })
      sendPrivateMessage(player.name, topbals)
    }
    
    
    // Help command
    if (cmd === '/bank' || cmd === '/bankhelp') {
      sendPrivateMessage(player.name, ' Virtual Bank Commands\n   /balance - Check your balance\n   /daily - Claim 200 Tokens (must finish final quest)\n   /pay <player> <amount> - Transfer coins\n   /cf <amount> - Coin flip (max 1,000)\n   /transactions - View recent transactions\n   /baltop - View leaderboard ')
      

      if (isAdminHelper(player.name)) {
        sendPrivateMessage(player.name, '--- Admin Commands ---\n /deposit <player> <amount> - Give coins\n /withdraw <player> <amount> - Remove coins')
      }
    }

    // Daily reward (requires completion of final quest)
    if (cmd === '/daily') {
      // Find the last quest in the chain (the one with no nextQuestId)
      const finalQuestId = QUESTS.length > 0
        ? (QUESTS.find(q => !q.nextQuestId)?.id ?? QUESTS[QUESTS.length - 1].id)
        : null
      const questAPI = getQuestAPI()
      const completed = finalQuestId && questAPI && typeof questAPI.hasCompletedQuest === 'function'
        ? questAPI.hasCompletedQuest(player.name, finalQuestId)
        : false
      if (!completed) {
        sendPrivateMessage(player.name, `${player.name}: You must finish the final quest before using /daily.`)
        return
      }

      const normalized = normalizePlayerName(player.name, 'upper')
      const lastKey = `daily_${normalized}`
      const lastClaim = ex.storage.get(lastKey, 0)
      const now = Date.now()
      const dayMs = 24 * 60 * 60 * 1000
      if (now - lastClaim < dayMs) {
        sendPrivateMessage(player.name, `${player.name}: You already claimed /daily. Try again later.`)
        return
      }

      const dailyAmount = config.economy.dailyReward
      const account = getAccount(player.name)
      account.balance += dailyAmount
      saveAccount(player.name, account)
      addTransaction(player.name, {
        type: 'reward',
        amount: dailyAmount,
        reason: 'Daily reward',
        timestamp: now
      })
      ex.storage.set(lastKey, now)
      sendPrivateMessage(player.name, `${player.name}: Claimed ${dailyAmount} Tokens from /daily. New balance: ${formatCoins(account.balance)}`)
    }
  })
  
  // Welcome bonus for new players
  ex.world.onJoin.sub((player) => {
    const normalizedName = normalizePlayerName(player.name, 'upper')
    const account = ex.storage.get(`bank_${normalizedName}`, null)
    
    if (!account) {
      // New player - give welcome bonus
      const newAccount: BankAccount = {
        balance: 0,
        transactions: [],
        lastActive: Date.now()
      }
      
      ex.storage.set(`bank_${normalizedName}`, newAccount)
    }
  })
  
  // Export functions for other extensions
  ex.exports = {
    getBalance: (playerName: string) => getAccount(playerName).balance,
    
    addCoins: (playerName: string, amount: number, reason: string) => {
      const account = getAccount(playerName)
      account.balance += amount
      saveAccount(playerName, account)
      addTransaction(playerName, {
        type: 'reward',
        amount: amount,
        reason: reason,
        timestamp: Date.now()
      })
    },
    
    removeCoins: (playerName: string, amount: number, reason: string): boolean => {
      const account = getAccount(playerName)
      if (account.balance < amount) return false
      
      account.balance -= amount
      saveAccount(playerName, account)
      addTransaction(playerName, {
        type: 'withdraw',
        amount: -amount,
        reason: reason,
        timestamp: Date.now()
      })
      return true
    },
    
    hasCoins: (playerName: string, amount: number): boolean => {
      return getAccount(playerName).balance >= amount
    }
  }
  
  ex.remove = () => {
    console.log('Virtual Bank System unloaded')
  }
})
