import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';

// 初始化
bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

/**
 * Prove服务类
 * 包含所有spell相关的功能：提取script、生成地址、签名PSBT
 */
export default class ProveService {

  // ==================== Script提取功能 ====================

  /**
   * 从spell交易中提取script数据
   * @param {string} spellTxHex - spell交易的hex
   * @param {number} targetInputIndex - 指定要提取的输入索引（可选，默认自动查找）
   * @returns {Object} 包含script和相关信息
   */
  static extractScriptFromSpellTx(spellTxHex, targetInputIndex = null) {
    try {
      const spellTx = bitcoin.Transaction.fromHex(spellTxHex);

      // 查找包含spell数据的输入
      let targetInput = null;
      let inputIndex = -1;

      if (targetInputIndex !== null && targetInputIndex >= 0) {
        // 如果指定了输入索引，直接使用
        if (targetInputIndex >= spellTx.ins.length) {
          throw new Error(`指定的输入索引 ${targetInputIndex} 超出范围`);
        }
        targetInput = spellTx.ins[targetInputIndex];
      } else {
        // 自动查找包含有效witness的输入（witness长度>=3，且包含spell标记）
        for (let i = 0; i < spellTx.ins.length; i++) {
          const input = spellTx.ins[i];

          // 检查witness格式：[signature, tapscript, controlBlock]
          if (input.witness && input.witness.length >= 3) {
            // 尝试检查是否包含spell数据
            try {
              const tapscript = input.witness[1];
              const scriptASM = bitcoin.script.toASM(tapscript);

              // 检查是否包含"spell"标记
              if (scriptASM.includes('7370656c6c')) { // 'spell' in hex
                targetInput = input;
                inputIndex = i;
                break;
              }
            } catch {
              // 如果解析失败，继续查找下一个
            }
          }
        }
      }

      if (!targetInput || !targetInput.witness || targetInput.witness.length < 3) {
        throw new Error('未找到包含spell数据的输入');
      }

      // 提取tapscript (witness[1])
      const tapscript = targetInput.witness[1];
      const controlBlock = targetInput.witness[2];

      // 提取spell数据
      const spellData = this.extractSpellDataFromScript(tapscript);

      // 返回从实际交易中提取的数据
      return {
        tapscript: tapscript.toString('hex'),
        controlBlock: controlBlock.toString('hex'),
        spellData: spellData.toString('hex')
      };

    } catch (error) {
      throw new Error(`提取script失败: ${error.message}`);
    }
  }

  /**
   * 从tapscript中提取spell数据
   * @param {Buffer} scriptBuffer - tapscript buffer
   * @returns {Buffer} spell数据
   */
  static extractSpellDataFromScript(scriptBuffer) {
    const script = bitcoin.script.decompile(scriptBuffer);
    const chunks = [];
    let collecting = false;

    for (const op of script) {
      if (Buffer.isBuffer(op) && op.toString() === 'spell') {
        collecting = true;
        continue;
      }
      if (collecting) {
        if (op === bitcoin.script.OPS.OP_ENDIF) break;
        if (Buffer.isBuffer(op)) chunks.push(op);
      }
    }

    return Buffer.concat(chunks);
  }

  // ==================== 地址生成功能 ====================

  /**
   * 通过私钥和spell数据生成脚本地址
   * @param {string} privateKeyHex - 私钥hex
   * @param {string} spellDataHex - spell数据hex
   * @param {string} network - 网络类型
   * @returns {Object} 地址和相关信息
   */
  static generateScriptAddress(privateKeyHex, spellDataHex, network = bitcoin.networks.bitcoin) {
    try {
      // 创建密钥对
      const keyPair = ECPair.fromPrivateKey(
        Buffer.from(privateKeyHex, 'hex')
      );

      // 获取x-only公钥
      const xOnlyPubkey = keyPair.publicKey.length === 32
        ? keyPair.publicKey
        : keyPair.publicKey.slice(1, 33);

      // 解析spell数据
      const spellData = Buffer.from(spellDataHex, 'hex');

      // 构建tapscript
      const tapscript = bitcoin.script.compile([
        bitcoin.script.OPS.OP_FALSE,
        bitcoin.script.OPS.OP_IF,
        Buffer.from('spell'),
        ...this.chunkSpellData(spellData),
        bitcoin.script.OPS.OP_ENDIF,
        xOnlyPubkey,
        bitcoin.script.OPS.OP_CHECKSIG
      ]);

      // 创建taproot地址
      const scriptTree = { output: tapscript };

      // 使用用户的公钥（允许 key-path 和 script-path 花费）
      const internalPubkey = xOnlyPubkey;

      const p2tr = bitcoin.payments.p2tr({
        internalPubkey,
        scriptTree,
        network,
        redeem: {
          output: tapscript,
          redeemVersion: 0xc0
        }
      });

      const { output: taprootOutput, address: taprootAddress } = p2tr;

      // 正确计算 control block
      // 使用 bitcoinjs-lib 内置的 control block 生成
      let controlBlock;

      try {
        // 创建一个临时的 witness 来获取正确的 control block
        const tempPsbt = new bitcoin.Psbt({ network });
        tempPsbt.addInput({
          hash: 'a'.repeat(64),
          index: 0,
          witnessUtxo: {
            script: taprootOutput,
            value: 1000
          },
          tapInternalKey: internalPubkey,
          tapLeafScript: [{
            leafVersion: 0xc0,
            script: tapscript,
            controlBlock: p2tr.witness?.[2] || Buffer.concat([Buffer.from([0xc0]), internalPubkey])
          }]
        });

        // 从 tapLeafScript 中获取正确的 control block
        const tapLeafScript = tempPsbt.data.inputs[0].tapLeafScript?.[0];
        if (tapLeafScript) {
          controlBlock = tapLeafScript.controlBlock;
        } else {
          // 备用方案：手动计算 control block
          controlBlock = this.calculateControlBlock(internalPubkey, tapscript, taprootOutput);
        }
      } catch (e) {
        // 如果上述方法失败，手动计算 control block
        controlBlock = this.calculateControlBlock(internalPubkey, tapscript, taprootOutput);
      }

      return {
        address: taprootAddress,
        tapscript: tapscript.toString('hex'),
        controlBlock: controlBlock.toString('hex'),
        publicKey: keyPair.publicKey.toString('hex'),
        xOnlyPubkey: xOnlyPubkey.toString('hex'),
        taprootOutput: taprootOutput.toString('hex'),
        keyPair // 返回keyPair供后续使用
      };

    } catch (error) {
      throw new Error(`生成脚本地址失败: ${error.message}`);
    }
  }

  /**
   * 计算正确的 control block
   * @param {Buffer} internalPubkey - 内部公钥
   * @param {Buffer} tapscript - tapscript
   * @param {Buffer} taprootOutput - taproot 输出脚本
   * @returns {Buffer} control block
   */
  static calculateControlBlock(internalPubkey, tapscript, taprootOutput) {
    // 计算 leaf hash
    const scriptLen = tapscript.length;
    let lenBytes;
    if (scriptLen < 0xfd) {
      lenBytes = Buffer.from([scriptLen]);
    } else if (scriptLen <= 0xffff) {
      lenBytes = Buffer.concat([
        Buffer.from([0xfd]),
        Buffer.from([scriptLen & 0xff, (scriptLen >> 8) & 0xff])
      ]);
    } else {
      throw new Error('Script too large');
    }

    const leafHash = bitcoin.crypto.taggedHash(
      'TapLeaf',
      Buffer.concat([
        Buffer.from([0xc0]), // leaf version
        lenBytes,            // compact size encoded script length
        tapscript            // the script itself
      ])
    );

    // 计算 taproot tweak
    const tweak = bitcoin.crypto.taggedHash(
      'TapTweak',
      Buffer.concat([internalPubkey, leafHash])
    );

    // 计算输出公钥和正确的 parity
    const outputPubkey = ecc.xOnlyPointAddTweak(internalPubkey, tweak);
    if (!outputPubkey) {
      throw new Error('Failed to calculate output pubkey');
    }

    // 确定正确的 parity bit
    let parity = outputPubkey.parity;

    // 如果提供了 taproot 输出脚本，验证一致性
    if (taprootOutput) {
      if (taprootOutput.length === 34 && taprootOutput[0] === 0x51 && taprootOutput[1] === 0x20) {
        const outputPubkeyFromScript = taprootOutput.slice(2);
        // 验证计算出的公钥与脚本中的公钥是否匹配
        if (Buffer.compare(outputPubkey.xOnlyPubkey, outputPubkeyFromScript) !== 0) {
          throw new Error('Output pubkey mismatch - internal pubkey or script may be incorrect');
        }
      }
    }

    // 构建 control block: [leaf_version | parity, internal_pubkey]
    const controlBlock = Buffer.concat([
      Buffer.from([0xc0 | parity]), // leaf version (0xc0) + parity bit
      internalPubkey
    ]);

    return controlBlock;
  }

  // ==================== PSBT签名功能 ====================

  /**
   * 签名PSBT中的spell输入
   * @param {string} psbtBase64 - PSBT的base64编码
   * @param {number} inputIndex - 要签名的输入索引
   * @param {string} privateKeyHex - 私钥hex
   * @param {string} tapscriptHex - tapscript hex
   * @returns {Object} 签名结果
   */
  static signPsbtSpellInput(psbtBase64, inputIndex, privateKeyHex, tapscriptHex) {
    try {
      const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.bitcoin });

      // 准备交易信息
      const txInfo = {
        inputs: [],
        outputs: [],
        signIndex: inputIndex
      };

      // 提取输入信息
      for (let i = 0; i < psbt.inputCount; i++) {
        const input = psbt.data.inputs[i];
        const txInput = psbt.txInputs[i];

        txInfo.inputs.push({
          txid: txInput.hash.reverse().toString('hex'),
          vout: txInput.index,
          sequence: txInput.sequence,
          script: input.witnessUtxo ? input.witnessUtxo.script.toString('hex') : undefined,
          value: input.witnessUtxo ? input.witnessUtxo.value : 1000
        });
      }

      // 提取输出信息
      for (const output of psbt.txOutputs) {
        txInfo.outputs.push({
          script: output.script.toString('hex'),
          value: output.value
        });
      }

      // 创建witness
      const witnessResult = this.createSpellWitness(privateKeyHex, tapscriptHex, txInfo);

      // 应用witness到PSBT
      const input = psbt.data.inputs[inputIndex];
      if (!input) {
        throw new Error(`输入 ${inputIndex} 不存在`);
      }

      // 设置finalScriptWitness
      input.finalScriptWitness = bitcoin.script.compile(witnessResult.witnessStack);

      return {
        success: true,
        signedPsbt: psbt.toBase64(),
        signature: witnessResult.signature,
        pubkey: witnessResult.pubkey,
        witness: witnessResult.witness,
        inputIndex
      };

    } catch (error) {
      throw new Error(`签名PSBT失败: ${error.message}`);
    }
  }

  /**
   * 生成 finalScriptWitness (从 PSBT)
   * @param {bitcoin.Psbt|string} psbtOrBase64 - PSBT 对象或 base64 字符串
   * @param {number} inputIndex - 要签名的输入索引
   * @param {string} privateKeyHex - 私钥 hex
   * @param {string} tapscriptHex - tapscript hex
   * @returns {string} finalScriptWitness 的 hex 字符串
   */
  static generateFinalScriptWitnessFromPsbt(psbtOrBase64, inputIndex, privateKeyHex, tapscriptHex) {
    // 解析 PSBT
    const psbt = typeof psbtOrBase64 === 'string'
      ? bitcoin.Psbt.fromBase64(psbtOrBase64)
      : psbtOrBase64;

    // 从 PSBT 提取交易信息
    const txInfo = {
      inputs: [],
      outputs: [],
      signIndex: inputIndex
    };

    // 提取所有输入
    for (let i = 0; i < psbt.inputCount; i++) {
      const input = psbt.data.inputs[i];
      const txInput = psbt.txInputs[i];

      txInfo.inputs.push({
        txid: txInput.hash.reverse().toString('hex'),
        vout: txInput.index,
        value: input.witnessUtxo ? input.witnessUtxo.value : 1000,
        script: input.witnessUtxo ? input.witnessUtxo.script.toString('hex') : undefined
      });
    }

    // 提取所有输出
    for (const output of psbt.txOutputs) {
      txInfo.outputs.push({
        script: output.script.toString('hex'),
        value: output.value
      });
    }

    // 调用原始函数生成 finalScriptWitness
    // 注意：这里没有传递 controlBlockHex，让函数自动生成
    return this.generateFinalScriptWitness(privateKeyHex, tapscriptHex, txInfo, null);
  }

  /**
   * 生成 finalScriptWitness (从交易信息)
   * @param {string} privateKeyHex - 私钥 hex
   * @param {string} tapscriptHex - tapscript hex
   * @param {Object} txInfo - 交易信息，包含:
   *   - inputs: 输入数组 [{txid, vout, value, script}]
   *   - outputs: 输出数组 [{address, value} 或 {script, value}]
   *   - signIndex: 要签名的输入索引
   * @param {string} controlBlockHex - control block hex (可选)
   * @returns {string} finalScriptWitness 的 hex 字符串
   */
  static generateFinalScriptWitness(privateKeyHex, tapscriptHex, txInfo, controlBlockHex = null) {
    // 1. 创建 witness 组件
    const witnessResult = this.createSpellWitness(privateKeyHex, tapscriptHex, txInfo, controlBlockHex);

    // 2. 构建 finalScriptWitness
    // Witness stack 格式: [签名, tapscript, control block]
    const witnessElements = [
      Buffer.from(witnessResult.signature, 'hex'),
      Buffer.from(witnessResult.tapscript, 'hex'),
      Buffer.from(witnessResult.controlBlock, 'hex')
    ];

    // 手动构建 witness 格式
    const witnessBuffers = [];

    // 添加元素数量 (3个元素)
    witnessBuffers.push(Buffer.from([witnessElements.length]));

    // 添加每个元素
    for (const element of witnessElements) {
      // 对于每个元素，先写长度，再写数据
      if (element.length < 0xfd) {
        witnessBuffers.push(Buffer.from([element.length]));
      } else {
        // 处理大于252字节的元素
        const lenBuf = Buffer.allocUnsafe(3);
        lenBuf[0] = 0xfd;
        lenBuf.writeUInt16LE(element.length, 1);
        witnessBuffers.push(lenBuf);
      }
      witnessBuffers.push(element);
    }

    const finalScriptWitness = Buffer.concat(witnessBuffers);
    return finalScriptWitness.toString('hex');
  }

  /**
   * 创建spell witness
   * @param {string} privateKeyHex - 私钥
   * @param {string} tapscriptHex - tapscript
   * @param {Object} txInfo - 交易信息
   * @param {string} controlBlockHex - control block hex (可选，如果不提供则自动生成)
   * @returns {Object} witness信息
   */
  static createSpellWitness(privateKeyHex, tapscriptHex, txInfo, controlBlockHex = null) {
    try {
      // 创建密钥对
      const keyPair = ECPair.fromPrivateKey(
        Buffer.from(privateKeyHex, 'hex'),
        { network: bitcoin.networks.bitcoin }
      );

      const tapscript = Buffer.from(tapscriptHex, 'hex');

      // 获取 x-only 公钥（用作内部公钥，与地址生成保持一致）
      const xOnlyPubkey = keyPair.publicKey.length === 32
        ? keyPair.publicKey
        : keyPair.publicKey.slice(1, 33);

      // 创建交易对象
      const tx = new bitcoin.Transaction();
      tx.version = 2;

      // 添加输入
      if (txInfo.inputs) {
        for (const input of txInfo.inputs) {
          tx.addInput(
            Buffer.from(input.txid, 'hex').reverse(),
            input.vout,
            input.sequence || 0xfffffffd
          );
        }
      }

      // 添加输出
      if (txInfo.outputs) {
        for (const output of txInfo.outputs) {
          if (output.address) {
            tx.addOutput(
              bitcoin.address.toOutputScript(output.address, bitcoin.networks.bitcoin),
              output.value
            );
          } else if (output.script) {
            tx.addOutput(Buffer.from(output.script, 'hex'), output.value);
          }
        }
      }

      // 签名类型
      // 对于 Tapscript 签名，推荐使用 SIGHASH_DEFAULT (0x00)
      // 这避免了在签名末尾附加 sighash byte，简化了验证过程
      const sighash = bitcoin.Transaction.SIGHASH_DEFAULT;

      // 构建prevout信息
      const prevoutScripts = [];
      const prevoutValues = [];

      for (const input of txInfo.inputs) {
        prevoutScripts.push(Buffer.from(input.script || '512014' + 'a'.repeat(62), 'hex'));
        prevoutValues.push(input.value || 1000);
      }

      // 计算 leaf hash (根据 BIP 341)
      const scriptLen = tapscript.length;
      let lenBytes;
      if (scriptLen < 0xfd) {
        lenBytes = Buffer.from([scriptLen]);
      } else if (scriptLen <= 0xffff) {
        lenBytes = Buffer.concat([
          Buffer.from([0xfd]),
          Buffer.from([scriptLen & 0xff, (scriptLen >> 8) & 0xff])
        ]);
      } else {
        throw new Error('Script too large');
      }

      const leafHash = bitcoin.crypto.taggedHash(
        'TapLeaf',
        Buffer.concat([
          Buffer.from([0xc0]), // leaf version
          lenBytes,            // compact size encoded length
          tapscript           // the script
        ])
      );

      // 计算签名哈希
      let hash;
      try {
        hash = tx.hashForWitnessV1(
          txInfo.signIndex || 0,
          prevoutScripts,
          prevoutValues,
          sighash,
          leafHash  // 使用 leafHash 而不是 tapscript
        );
      } catch (e) {
        throw new Error(`计算签名哈希失败: ${e.message}`);
      }

      // Schnorr签名
      const signature = keyPair.signSchnorr(hash);
      // 对于 SIGHASH_DEFAULT (0x00)，不需要在签名末尾附加 sighash byte
      // 对于其他 sighash 类型，需要附加 sighash byte
      const finalSig = sighash === bitcoin.Transaction.SIGHASH_DEFAULT
        ? signature
        : Buffer.concat([signature, Buffer.from([sighash])]);

      // 使用提供的 control block 或生成一个新的
      let controlBlock;
      if (controlBlockHex) {
        // 使用提供的 control block（从地址生成时获得）
        controlBlock = Buffer.from(controlBlockHex, 'hex');
      } else {
        // 生成 control block（与地址生成保持一致）
        // 重新创建 taproot 地址以获得正确的 control block
        const scriptTree = { output: tapscript };
        const p2tr = bitcoin.payments.p2tr({
          internalPubkey: xOnlyPubkey,
          scriptTree,
          network: bitcoin.networks.bitcoin,
          redeem: {
            output: tapscript,
            redeemVersion: 0xc0
          }
        });

        // 如果仍然无法从 p2tr.witness 获取，手动计算
        if (p2tr.witness && p2tr.witness.length > 2) {
          controlBlock = p2tr.witness[p2tr.witness.length - 1];
        } else {
          // 手动计算 control block
          controlBlock = this.calculateControlBlock(xOnlyPubkey, tapscript, p2tr.output);
        }

        if (!controlBlock) {
          throw new Error('无法生成 control block');
        }
      }

      return {
        signature: finalSig.toString('hex'),
        tapscript: tapscriptHex,
        controlBlock: controlBlock.toString('hex'),
        witnessStack: [
          finalSig,
          tapscript,
          controlBlock
        ],
        witness: {
          signature: finalSig.toString('hex'),
          tapscript: tapscriptHex,
          controlBlock: controlBlock.toString('hex')
        },
        pubkey: keyPair.publicKey.toString('hex')
      };

    } catch (error) {
      throw new Error(`创建witness失败: ${error.message}`);
    }
  }

  // ==================== 工具函数 ====================

  /**
   * 将spell数据分块
   * @param {Buffer} spellData - spell数据
   * @returns {Array<Buffer>} 数据块数组
   */
  static chunkSpellData(spellData) {
    const chunks = [];
    const maxChunkSize = 520; // Bitcoin脚本最大块大小

    for (let i = 0; i < spellData.length; i += maxChunkSize) {
      const chunk = spellData.slice(i, i + maxChunkSize);
      chunks.push(chunk);
    }

    return chunks;
  }

  /**
   * 验证私钥格式
   * @param {string} privateKeyHex - 私钥hex
   * @returns {boolean} 是否有效
   */
  static validatePrivateKey(privateKeyHex) {
    try {
      const privateKeyBuffer = Buffer.from(privateKeyHex.replace('0x', ''), 'hex');
      if (privateKeyBuffer.length !== 32) {
        return false;
      }
      ECPair.fromPrivateKey(privateKeyBuffer, { network: bitcoin.networks.bitcoin });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 从PSBT提取交易信息
   * @param {string} psbtBase64 - PSBT base64
   * @returns {Object} 交易信息
   */
  static extractTxInfoFromPsbt(psbtBase64) {
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.bitcoin });
    const txInfo = {
      inputs: [],
      outputs: []
    };

    // 提取输入
    for (let i = 0; i < psbt.inputCount; i++) {
      const input = psbt.data.inputs[i];
      const txInput = psbt.txInputs[i];

      txInfo.inputs.push({
        index: i,
        txid: txInput.hash.reverse().toString('hex'),
        vout: txInput.index,
        sequence: txInput.sequence,
        script: input.witnessUtxo ? input.witnessUtxo.script.toString('hex') : undefined,
        value: input.witnessUtxo ? input.witnessUtxo.value : undefined
      });
    }

    // 提取输出
    for (let i = 0; i < psbt.txOutputs.length; i++) {
      const output = psbt.txOutputs[i];
      txInfo.outputs.push({
        index: i,
        script: output.script.toString('hex'),
        value: output.value,
        address: this.scriptToAddress(output.script)
      });
    }

    return txInfo;
  }

  /**
   * 将脚本转换为地址
   * @param {Buffer} script - 输出脚本
   * @returns {string|null} 地址
   */
  static scriptToAddress(script) {
    try {
      // 尝试P2TR
      const p2tr = bitcoin.payments.p2tr({ output: script, network: bitcoin.networks.bitcoin });
      if (p2tr.address) return p2tr.address;

      // 尝试P2WPKH
      const p2wpkh = bitcoin.payments.p2wpkh({ output: script, network: bitcoin.networks.bitcoin });
      if (p2wpkh.address) return p2wpkh.address;

      // 尝试P2PKH
      const p2pkh = bitcoin.payments.p2pkh({ output: script, network: bitcoin.networks.bitcoin });
      if (p2pkh.address) return p2pkh.address;

      return null;
    } catch {
      return null;
    }
  }

  // ==================== 完整流程示例 ====================

  /**
   * 完整的spell处理流程示例
   * @param {Object} params - 参数
   * @returns {Object} 处理结果
   */
  static async processSpellWorkflow(params) {
    const results = {};

    try {
      // 步骤1: 提取script
      if (params.spellTxHex) {
        console.log('步骤1: 提取spell数据...');
        results.extraction = this.extractScriptFromSpellTx(
          params.spellTxHex,
          params.inputIndex  // 使用inputIndex替代commitTxHex
        );
        console.log('✓ 提取成功，spell数据长度:', results.extraction.spellData.length / 2, '字节');
      }

      // 步骤2: 生成地址
      if (params.privateKey && (params.spellData || results.extraction?.spellData)) {
        console.log('步骤2: 生成脚本地址...');
        const spellData = params.spellData || results.extraction.spellData;
        results.address = this.generateScriptAddress(
          params.privateKey,
          spellData,
          params.network || 'mainnet'
        );
        console.log('✓ 地址生成成功:', results.address.address);
      }

      // 步骤3: 签名PSBT
      if (params.psbtBase64 && params.privateKey && params.tapscript) {
        console.log('步骤3: 签名PSBT...');
        results.signature = this.signPsbtSpellInput(
          params.psbtBase64,
          params.inputIndex || 0,
          params.privateKey,
          params.tapscript
        );
        console.log('✓ 签名成功');
      }

      return {
        success: true,
        results
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        results
      };
    }
  }
}