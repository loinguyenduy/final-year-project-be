import Wallet from '../models/Wallet.model.js';
import Transaction from '../models/Transaction.model.js';
import moment from 'moment';
import crypto from 'crypto';
import qs from 'qs';
import { sortObject } from '../../../core/utils/vnpay.util.js';
import User from '../../identity/models/User.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import {
    processFailedGatewayPayment,
    processSuccessfulGatewayPayment
} from './PaymentSettlement.service.js';

const normalizeVNPayIpAddress = (ipAddr) => {
    const firstIp = String(ipAddr || '').split(',')[0].trim();
    if (!firstIp || firstIp === '::1' || firstIp === '::ffff:127.0.0.1') {
        return '127.0.0.1';
    }
    return firstIp.replace('::ffff:', '');
};

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
        let returnUrl = process.env.VNP_TOPUP_RETURN_URL || process.env.VNP_RETURN_URL;

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
        vnp_Params['vnp_IpAddr'] = normalizeVNPayIpAddress(ipAddr);
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

const verifyVNPayParams = (vnpayParams) => {
    const normalizedParams = { ...vnpayParams };
    const secureHash = normalizedParams['vnp_SecureHash'];
    delete normalizedParams['vnp_SecureHash'];
    delete normalizedParams['vnp_SecureHashType'];

    const sortedParams = sortObject(normalizedParams);
    const secretKey = process.env.VNP_HASH_SECRET;
    const signData = qs.stringify(sortedParams, { encode: false });
    const hmac = crypto.createHmac("sha512", secretKey);
    const signed = hmac.update(Buffer.from(signData, 'utf-8')).digest("hex");

    return {
        isValid: secureHash === signed,
        sortedParams
    };
};

const settleVNPayPayment = async (vnpayParams) => {
    const { isValid, sortedParams } = verifyVNPayParams(vnpayParams);

    if (!isValid) {
        return {
            EM: "Invalid VNPay checksum.",
            EC: 97,
            DT: ""
        };
    }

    const orderCode = sortedParams['vnp_TxnRef'];
    const rspCode = sortedParams['vnp_ResponseCode'];
    const transactionStatus = sortedParams['vnp_TransactionStatus'];
    const vnpAmount = Number(sortedParams['vnp_Amount']) / 100;
    const isSuccessfulPayment = rspCode === "00" && (!transactionStatus || transactionStatus === "00");

    const settlementResult = isSuccessfulPayment
        ? await processSuccessfulGatewayPayment({
            paymentMethod: 'VNPAY',
            gatewayCode: orderCode,
            paidAmount: vnpAmount
        })
        : await processFailedGatewayPayment({
                paymentMethod: 'VNPAY',
                gatewayCode: orderCode
        });

    return {
        EM: settlementResult.EM,
        EC: settlementResult.EC,
        DT: {
            order_code: orderCode,
            response_code: rspCode,
            transaction_status: transactionStatus,
            payment_success: isSuccessfulPayment,
            settlement: settlementResult.DT
        }
    };
};

const mapSettlementToVNPayIPNResponse = (settlement) => {
    if (settlement.EC === 97) {
        return { RspCode: '97', Message: 'Invalid Checksum' };
    }

    if (settlement.EC === 0 && settlement.DT?.settlement?.already_processed) {
        return { RspCode: '02', Message: 'Order already confirmed' };
    }
    if (settlement.EC === 404) {
        return { RspCode: '01', Message: 'Order not found' };
    }
    if (settlement.EC === 400) {
        return { RspCode: '04', Message: 'Invalid amount' };
    }
    if (settlement.EC !== 0) {
        return { RspCode: '99', Message: settlement.EM };
    }

    return { RspCode: '00', Message: 'Confirm Success' };
};

const handleVNPayIPNService = async (vnpayParams) => {
    try {
        const settlement = await settleVNPayPayment(vnpayParams);
        return mapSettlementToVNPayIPNResponse(settlement);
    } catch (error) {
        console.log("Error in handleVNPayIPNService: ", error);
        return { RspCode: '99', Message: 'Unknown error' };
    }
};

const handleVNPayReturnService = async (vnpayParams) => {
    try {
        const settlement = await settleVNPayPayment(vnpayParams);

        if (settlement.EC === 97) {
            return {
                EM: settlement.EM,
                EC: 400,
                DT: settlement.DT
            };
        }

        return {
            EM: settlement.EM,
            EC: settlement.EC,
            DT: settlement.DT
        };
    } catch (error) {
        console.log("Error in handleVNPayReturnService: ", error);
        return { EM: "Unable to process VNPay return.", EC: 500, DT: "" };
    }
};

export { createVNPayTopUpLinkService, handleVNPayIPNService, handleVNPayReturnService };
