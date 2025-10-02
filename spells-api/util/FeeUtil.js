
export default class FeeUtil {

    static getTaprootScriptPathWitnessSize(tapLeafScript) {
        let size = 0;
    
        const stackItems = tapLeafScript.stack || [];
    
        // Witness item count: stack items + script + control block
        const itemCount = stackItems.length + 2;
        size += FeeUtil.varIntSize(itemCount);
    
        // Add each stack item
        for (const item of stackItems) {
            size += FeeUtil.varIntSize(item.length) + item.length;
        }
    
        // Add script
        size += FeeUtil.varIntSize(tapLeafScript.script.length) + tapLeafScript.script.length;
    
        // Add control block
        size += FeeUtil.varIntSize(tapLeafScript.controlBlock.length) + tapLeafScript.controlBlock.length;
    
        return size;
    }
    
    static estTxSize(inputs, outputs) {
        let baseSize = 4 + 4; // version + locktime
        let witnessSize = 0;
        const isSegWit = inputs.some(i => i.address?.startsWith('bc1') || i.address?.startsWith('3') || i.address?.startsWith('tp1') || i.address?.startsWith('bcrt1'));

        // 输入输出数量（VarInt）
        baseSize += FeeUtil.varIntSize(inputs.length) + FeeUtil.varIntSize(outputs.length);

        // ============= 输入计算 =============
        for (const input of inputs) {
            baseSize += FeeUtil.getInputSize(input.address);
            if (input.tapLeafScript) {
                witnessSize += FeeUtil.getTaprootScriptPathWitnessSize(input.tapLeafScript[0]); // 因为是数组
            }
        }

        // ============= 输出计算 =============
        for (const output of outputs) {
            baseSize += 8; // value（8字节）

            let scriptSize;
            if (output.script) {
                scriptSize = output.script.length + 1; // OP_RETURN 直接使用 script 长度
            } else {
                scriptSize = FeeUtil.getOutputSize(output.address);
            }

            baseSize += FeeUtil.varIntSize(scriptSize) + scriptSize;
        }

        // SegWit标记（如果有SegWit输入）
        if (isSegWit) baseSize += 2;

        // 最终 vsize = baseSize + (witnessSize / 4)
        return Math.ceil(baseSize + (witnessSize / 4));
    }

    static varIntSize(n) {
        return n < 0xfd ? 1 : 3;
    }

    static getInputSize(address) {
        let baseSize = 32 + 4 + 4; // txid + vout + sequence

        if (address.startsWith('bc1p') || address.startsWith('tb1p') || address.startsWith('bcrt1p')) { // P2TR
            baseSize += 1; // 空 scriptSig（1字节）
            baseSize += (1 + (1 + 64) + (1 + 33)) / 4; // Schnorr 签名 + 控制块
        }
        else if (address.startsWith('bc1q') || address.startsWith('tb1q') || address.startsWith('bcrt1q')) { // P2WPKH
            baseSize += 1; // 空 scriptSig（1字节）
            baseSize += ( 1 + (1 + 72) + (1 + 33)) / 4; // DER 签名 + 压缩公钥
        }
        else if (address.startsWith('3')) { // P2SH（可能是嵌套SegWit）
            const redeemScriptSize = 22; // 默认 P2SH-P2WPKH 的 redeemScript 是 22 字节
            baseSize += 1 + redeemScriptSize; // scriptSig 长度 + redeemScript
            baseSize += (1 + (1 + 72) + (1 + 33)) / 4; // 见证数据（DER 签名 + 压缩公钥）
        }
        else { // P2PKH（Legacy）
            const scriptSigSize =  107; // 默认估算
            baseSize += FeeUtil.varIntSize(scriptSigSize) + scriptSigSize;
        }

        return baseSize;
    }

    static getOutputSize(address) {
        let scriptSize;
        if (address.startsWith('bc1p') || address.startsWith('tb1p') || address.startsWith('bcrt1p')) {
            scriptSize = 34; // P2TR
        } else if (address.startsWith('bc1q') || address.startsWith('tb1q') || address.startsWith('bcrt1q')) {
            scriptSize = 22; // P2WPKH
        } else if (address.startsWith('3')) {
            scriptSize = 23; // P2SH
        } else {
            scriptSize = 25; // P2PKH
        }
        return scriptSize;
    }

    static getAdditionalOutputSize(address) {
        const scriptSize = FeeUtil.getOutputSize(address);
        return FeeUtil.varIntSize(scriptSize) + scriptSize + 8;
    }

    static getOutputFee(address, feerate) {
        const changeSize = FeeUtil.getAdditionalOutputSize(address);
        return Math.ceil(changeSize * feerate);
    }
}