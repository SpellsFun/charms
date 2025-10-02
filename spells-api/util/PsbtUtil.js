import * as bitcoin from "bitcoinjs-lib"
import * as psbtUtils from 'bitcoinjs-lib/src/psbt/psbtutils.js'
import * as ecc from "tiny-secp256k1";
import {toXOnly} from "bitcoinjs-lib/src/psbt/bip371.js";
import FeeUtil from "./FeeUtil.js";
import * as MempoolUtil from "./MempoolUtil.js";

bitcoin.initEccLib(ecc);

export default class PsbtUtil {

    static async createUnSignPsbt(inputList, outputList, changeAddress, feerate, checkFee = true) {
        const psbt = new bitcoin.Psbt({network: bitcoin.networks.bitcoin});
        if (checkFee) {
            psbt.setMaximumFeeRate(500000000);
        } else {
            psbt.setMaximumFeeRate(50000);
        }

        const inputToSign = [];
        const addressToIndexes = [];
        for (let i = 0; i < inputList.length; i++) {
            const input = inputList[i];
            if (!addressToIndexes[input.address]) {
                addressToIndexes[input.address] = [];
            }
            addressToIndexes[input.address].push(i);

            const vin = await PsbtUtil.utxo2PsbtInputEx(input);
            psbt.addInput(vin);

            inputToSign.push({
                address: input.address,
                index: i
            })
        }

        const signingIndexesArr = [];
        for (const [address, indexes] of Object.entries(addressToIndexes)) {
            signingIndexesArr.push({
                address,
                signingIndexes: indexes,
            });
        }

        if (outputList.length === 0) {
            throw new Error('The output is empty');
        }

        for (const output of outputList) {
            psbt.addOutput(output);
        }

        if (checkFee) {
            const totalInputValue = inputList.reduce((accumulator, currentValue) => accumulator + currentValue.value, 0);
            const totalOutputValue = outputList.reduce((accumulator, currentValue) => accumulator + currentValue.value, 0);
            const txSize = FeeUtil.estTxSize(inputList, [...outputList, {address: changeAddress}]);
            const fee = Math.ceil(txSize * feerate);
            const changeValue = totalInputValue - totalOutputValue - fee;

            if (changeValue > 546) {
                outputList.push({
                    address: changeAddress,
                    value: changeValue
                });
                return this.createUnSignPsbt(inputList, outputList, changeAddress, feerate, false);
            } else if (changeValue < 0) {
                throw new Error('Insufficient utxo balance');
            }
        }
        const txid = psbt.__CACHE.__TX.getId();

        const inputSum = inputList.reduce((sum, input) => sum + input.value, 0);
        const outputSum = outputList.reduce((sum, output) => sum + output.value, 0);
        const fee = inputSum - outputSum;

        return {
            fee: fee,
            hex: psbt.toHex(),
            txid: txid,
            base64: psbt.toBase64(),
            signingIndexes: signingIndexesArr,
            inputToSign: inputToSign
        };
    }

    static script2Address(output) {
        if (psbtUtils.isP2TR(output)) {
            const {address} = bitcoin.payments.p2tr({network: bitcoin.networks.bitcoin, output})
            return address;

        } else if (psbtUtils.isP2WPKH(output)) {
            const {address} = bitcoin.payments.p2wpkh({network: bitcoin.networks.bitcoin, output})
            return address;
        } else if (psbtUtils.isP2SHScript(output)) {
            const {address} = bitcoin.payments.p2sh({network: bitcoin.networks.bitcoin, output})
            return address;

        } else if (psbtUtils.isP2PKH(output)) {
            const {address} = bitcoin.payments.p2pkh({network: bitcoin.networks.bitcoin, output})
            return address;
        } else if (psbtUtils.isP2WSHScript(output)) {
            const {address} = bitcoin.payments.p2wsh({network: bitcoin.networks.bitcoin, output})
            return address;
        } else if (psbtUtils.isP2MS(output)) {
            const {address} = bitcoin.payments.p2ms({network: bitcoin.networks.bitcoin, output})
            return address;
        } else if (psbtUtils.isP2PK(output)) {
            const {address} = bitcoin.payments.p2pk({network: bitcoin.networks.bitcoin, output})
            return address;
        }
        throw new Error("unknow script")
    }

    static async utxo2PsbtInputEx(utxo) {
        const input = {hash: utxo.txid, index: utxo.vout, value: parseInt(utxo.value), address: utxo.address};
        let txHex = utxo.txHex
        let outScript
        if (!input.value || !input.address) {
            if (!txHex) {
                txHex = await MempoolUtil.getTxHex(utxo.txid);
            }
            const tx = bitcoin.Transaction.fromHex(txHex);
            input.value = tx.outs[utxo.vout].value
            outScript = tx.outs[utxo.vout].script
            input.address = PsbtUtil.script2Address(outScript)
        }
        if (!outScript) {
            outScript = bitcoin.address.toOutputScript(input.address, bitcoin.networks.bitcoin)
        }

        if (psbtUtils.isP2TR(outScript) || psbtUtils.isP2WPKH(outScript) || psbtUtils.isP2WSHScript(outScript)) {
            input.witnessUtxo = {script: outScript, value: input.value}
            if (psbtUtils.isP2TR(outScript)) {
                if (utxo.pubkey) {
                    input.tapInternalKey = toXOnly(Buffer.from(utxo.pubkey, 'hex'))
                } else if (utxo.tapInternalKey) {
                    input.tapInternalKey = Buffer.from(utxo.tapInternalKey, 'hex')
                } else {
                    // 对于简单的 key-path 花费，可以从 output script 提取
                    // 但对于 script-path 花费，需要显式提供 tapInternalKey
                    input.tapInternalKey = outScript.subarray(2)
                }
            }
        } else if (psbtUtils.isP2SHScript(outScript)) {
            input.witnessUtxo = {script: outScript, value: input.value};
            if (utxo.pubkey) {
                input.redeemScript = bitcoin.payments.p2wpkh({
                    network: bitcoin.networks.bitcoin,
                    pubkey: Buffer.from(utxo.pubkey, 'hex')
                }).output;
            }
        } else {
            if (!txHex) {
                txHex = await MempoolUtil.getTxHex(utxo.txid);
            }
            input.nonWitnessUtxo = Buffer.from(txHex, 'hex');
        }
        return input;
    }

}
