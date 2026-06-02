import Wallet from '../models/Wallet.model.js';
import Transaction from '../models/Transaction.model.js';
import db from '../../../core/database/connection.js';
import moment from 'moment';
import crypto from 'crypto';
import qs from 'qs';
import { sortObject } from '../../../core/utils/vnpay.util.js';
import User from '../../identity/models/User.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';

const createVNPayTopUpLinkService = async (userId, amount, ipAddr, targetWallet = 'MAIN') => {
    try {
        if (!amount || amount <= 0) return { EM: "Invalid amount.", EC: 400, DT: "" };

        const user = await User.findByPk(userId);
        if (!user) return { 
            EM: "User not found.", 
            EC: 404, 
            DT: "" 
        };

        let walletType = "CUSTOMER_MAIN";
        let txType = "TOP_UP";

        if (user.role === 'HANDYMAN') {
            if (targetWallet === 'ESCROW') {
                walletType = "HANDYMAN_ESCROW";
                txType = "BONDING_DEPOSIT";

                if (Number(amount) !== 2000000) {
                    return { 
                        EM: "Bonding deposit must be exactly 2,000,000 VND.", 
                        EC: 400, 
                        DT: "" 
                    };
                }

                const profile = await HandymanProfile.findOne({ where: { user_id: userId } });
                if (profile.security_bond_status === 'PAID') {
                    return { 
                        EM: "Security bond is already paid.", 
                        EC: 400, 
                        DT: "" 
                    };
                }
                
                if (!profile || profile.handyman_level !== 'C2') {
                    return { 
                        EM: "You must pass KYC review (Level C2) before depositing the security bond.", 
                        EC: 403, 
                        DT: "" 
                    };
                }
                
            } else {
                walletType = "HANDYMAN_MAIN";
            }
        }

        const wallet = await Wallet.findOne({ where: { user_id: userId, wallet_type: walletType } });
        if (!wallet) return { 
            EM: "Wallet not found for this user.", 
            EC: 404, 
            DT: "" 
        };
        if (wallet.is_blocked) return { 
            EM: "Your wallet is currently blocked.", 
            EC: 403, 
            DT: "" 
        };

        const orderCode = moment().format('DDHHmmss') + Math.floor(Math.random() * 100);

        await Transaction.create({
            amount: amount,
            transaction_type: txType, 
            status: 'PENDING',
            payment_method: 'VNPAY',
            payment_gateway_code: String(orderCode), 
            description: `Top up ${walletType} for user ${userId} via VNPay`,
            from_wallet_id: null, 
            to_wallet_id: wallet.id,
        });

        // Initialize VNPay parameters
        let tmnCode = process.env.VNP_TMN_CODE;
        let secretKey = process.env.VNP_HASH_SECRET;
        let vnpUrl = process.env.VNP_URL;
        let returnUrl = process.env.VNP_RETURN_URL;

        let date = new Date();
        let createDate = moment(date).format('YYYYMMDDHHmmss');
        
        let vnp_Params = {};
        vnp_Params['vnp_Version'] = '2.1.0';
        vnp_Params['vnp_Command'] = 'pay';
        vnp_Params['vnp_TmnCode'] = tmnCode;
        vnp_Params['vnp_Locale'] = 'vn';
        vnp_Params['vnp_CurrCode'] = 'VND';
        vnp_Params['vnp_TxnRef'] = orderCode;
        vnp_Params['vnp_OrderInfo'] = `Top up ${orderCode}`;
        vnp_Params['vnp_OrderType'] = 'other'; 
        vnp_Params['vnp_Amount'] = amount * 100; 
        vnp_Params['vnp_ReturnUrl'] = returnUrl;
        vnp_Params['vnp_IpAddr'] = ipAddr || '127.0.0.1';
        vnp_Params['vnp_CreateDate'] = createDate;

        vnp_Params = sortObject(vnp_Params);
        let signData = qs.stringify(vnp_Params, { encode: false });
        let hmac = crypto.createHmac("sha512", secretKey);
        let signed = hmac.update(Buffer.from(signData, 'utf-8')).digest("hex"); 
        vnp_Params['vnp_SecureHash'] = signed;

        vnpUrl += '?' + qs.stringify(vnp_Params, { encode: false });

        return { EM: "VNPay Payment link created successfully.", EC: 0, DT: vnpUrl };
    } catch (error) {
        console.log("Error in createVNPayTopUpLinkService: ", error);
        return { EM: "Internal server error.", EC: 500, DT: "" };
    }
};

const handleVNPayIPNService = async (vnpayParams) => {
    const trans = await db.transaction();
    try {
        let secureHash = vnpayParams['vnp_SecureHash'];
        delete vnpayParams['vnp_SecureHash'];
        delete vnpayParams['vnp_SecureHashType'];
        vnpayParams = sortObject(vnpayParams);

        let secretKey = process.env.VNP_HASH_SECRET;
        let signData = qs.stringify(vnpayParams, { encode: false });
        let hmac = crypto.createHmac("sha512", secretKey);
        let signed = hmac.update(Buffer.from(signData, 'utf-8')).digest("hex");

        if (secureHash === signed) {
            let orderCode = vnpayParams['vnp_TxnRef'];
            let rspCode = vnpayParams['vnp_ResponseCode'];
            let vnpAmount = vnpayParams['vnp_Amount'] / 100;

            const pendingTransaction = await Transaction.findOne({
                where: { payment_gateway_code: String(orderCode) },
                transaction: trans
            });

            if (!pendingTransaction) {
                await trans.rollback();
                return { RspCode: '01', Message: 'Order not found' };
            }
            if (Number(pendingTransaction.amount) !== Number(vnpAmount)) {
                await trans.rollback();
                return { RspCode: '04', Message: 'Invalid amount' };
            }
            if (pendingTransaction.status !== 'PENDING') {
                await trans.rollback();
                return { RspCode: '02', Message: 'Order already confirmed' };
            }

            if (rspCode === "00") {
                const wallet = await Wallet.findOne({
                    where: { id: pendingTransaction.to_wallet_id },
                    transaction: trans
                });

                if (wallet) {
                    const newBalance = parseFloat(wallet.balance) + parseFloat(pendingTransaction.amount);
                    await wallet.update({ balance: newBalance }, { transaction: trans });
                    await pendingTransaction.update({ status: 'SUCCESS' }, { transaction: trans });

                    if (pendingTransaction.transaction_type === 'BONDING_DEPOSIT') {
                        await HandymanProfile.update(
                            { security_bond_status: 'PAID', handyman_level: 'C3' },
                            { where: { user_id: wallet.user_id }, transaction: trans }
                        );
                    }
                    console.log(`>>> VNPay IPN Success: Wallet ${wallet.id} topped up ${pendingTransaction.amount}`);
                }
            } else {
                await pendingTransaction.update({ status: 'FAILED' }, { transaction: trans });
                console.log(`>>> VNPay IPN Failed: Transaction ${orderCode} failed with code ${rspCode}`);
            }

            await trans.commit();
            return { RspCode: '00', Message: 'Confirm Success' };
        } else {
            await trans.rollback();
            return { RspCode: '97', Message: 'Invalid Checksum' };
        }
    } catch (error) {
        await trans.rollback();
        console.log("Error in handleVNPayIPNService: ", error);
        return { RspCode: '99', Message: 'Unknown error' };
    }
};

export { createVNPayTopUpLinkService, handleVNPayIPNService };