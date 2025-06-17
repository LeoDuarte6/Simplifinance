const functions = require("firebase-functions");
const admin = require("firebase-admin");
const authorizenet = require("authorizenet");
require("dotenv").config(); 

admin.initializeApp();

const { APIContracts, Constants, APIControllers } = authorizenet;
const authNetEnvironment = Constants.endpoint.sandbox;

exports.createSubscription = functions.https.onCall(async (data, context) => {
    functions.logger.info("--- New Request Received ---", { email: data.email, plan: data.planName });

    if (!data || !data.email || !data.planPrice || !data.paymentDetails) {
        throw new functions.https.HttpsError('invalid-argument', 'Request is missing required data.');
    }
    
    const { email, password, planName, planPrice, paymentDetails } = data;
    const { cardNumber, expiryDate, cardCode } = paymentDetails;

    if (!cardNumber || !expiryDate || !cardCode) {
         throw new functions.https.HttpsError('invalid-argument', 'Request is missing payment details.');
    }

    const apiLoginId = process.env.AUTHORIZENET_API_LOGIN_ID;
    const transactionKey = process.env.AUTHORIZENET_TRANSACTION_KEY;

    if (!apiLoginId || !transactionKey) {
        functions.logger.error("Authorize.Net credentials not found in .env file.");
        throw new functions.https.HttpsError('internal', 'Server payment configuration error.');
    }

    const merchantAuthenticationType = new APIContracts.MerchantAuthenticationType();
    merchantAuthenticationType.setName(apiLoginId);
    merchantAuthenticationType.setTransactionKey(transactionKey);

    const paymentSchedule = new APIContracts.PaymentScheduleType();
    const interval = new APIContracts.PaymentScheduleType.Interval();
    interval.setLength(1);
    interval.setUnit(APIContracts.ARBSubscriptionUnitEnum.MONTHS);
    paymentSchedule.setInterval(interval);
    paymentSchedule.setStartDate(new Date().toISOString().substring(0, 10));
    paymentSchedule.setTotalOccurrences(9999);

    const creditCard = new APIContracts.CreditCardType();
    creditCard.setCardNumber(cardNumber);
    if (typeof expiryDate !== 'string' || !expiryDate.includes('/')) {
        throw new functions.https.HttpsError('invalid-argument', `Invalid expiry date format. Use MM/YY.`);
    }
    const [month, year] = expiryDate.split('/');
    creditCard.setExpirationDate(`20${year}-${month}`);
    creditCard.setCardCode(cardCode);

    const payment = new APIContracts.PaymentType();
    payment.setCreditCard(creditCard);

    const arbSubscription = new APIContracts.ARBSubscriptionType();
    arbSubscription.setName(planName);
    arbSubscription.setPaymentSchedule(paymentSchedule);
    arbSubscription.setAmount(planPrice);
    arbSubscription.setPayment(payment);

    const createRequest = new APIContracts.ARBCreateSubscriptionRequest();
    createRequest.setMerchantAuthentication(merchantAuthenticationType);
    createRequest.setSubscription(arbSubscription);

    const ctrl = new APIControllers.ARBCreateSubscriptionController(createRequest.getJSON());
    ctrl.setEnvironment(authNetEnvironment);

    return new Promise((resolve, reject) => {
        ctrl.execute(async () => {
            const apiResponse = ctrl.getResponse();
            const response = new APIContracts.ARBCreateSubscriptionResponse(apiResponse);

            if (response != null && response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
                const subscriptionId = response.getSubscriptionId();
                try {
                    const userRecord = await admin.auth().createUser({ email, password });
                    await admin.firestore().collection("users").doc(userRecord.uid).set({
                        email: email, planName: planName, authNetSubscriptionId: subscriptionId,
                        subscriptionStatus: "active", createdAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    resolve({ status: 'success', userId: userRecord.uid });
                } catch (error) {
                    functions.logger.error("Payment succeeded but user creation failed.", error);
                    reject(new functions.https.HttpsError('internal', 'Payment succeeded, but user account creation failed.'));
                }
            } else {
                const message = response.getMessages().getMessage()[0];
                functions.logger.error(`Payment failed: ${message.getText()}`);
                reject(new functions.https.HttpsError('aborted', `Payment failed: ${message.getText()}`));
            }
        });
    });
});