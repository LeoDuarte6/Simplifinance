const functions = require("firebase-functions");
const admin = require("firebase-admin");
const authorizenet = require("authorizenet");

require("dotenv").config();
admin.initializeApp();

const { APIContracts, Constants, APIControllers } = authorizenet;

exports.createSubscription = functions.https.onCall(async (data, context) => {
    functions.logger.info(`Starting subscription request for: ${data.email}`);

    const apiLoginId = process.env.AUTHORIZENET_API_LOGIN_ID;
    const transactionKey = process.env.AUTHORIZENET_TRANSACTION_KEY;

    if (!apiLoginId || !transactionKey) {
        throw new functions.https.HttpsError('internal', 'The server is not configured for payments.');
    }

    const merchantAuthenticationType = new APIContracts.MerchantAuthenticationType();
    merchantAuthenticationType.setName(apiLoginId);
    merchantAuthenticationType.setTransactionKey(transactionKey);

    const interval = new APIContracts.PaymentScheduleType.Interval();
    interval.setLength(1);
    interval.setUnit(APIContracts.ARBSubscriptionUnitEnum.MONTHS);

    const paymentSchedule = new APIContracts.PaymentScheduleType();
    paymentSchedule.setInterval(interval);
    paymentSchedule.setStartDate(new Date().toISOString().substring(0, 10));
    paymentSchedule.setTotalOccurrences(9999);

    const creditCard = new APIContracts.CreditCardType();
    creditCard.setCardNumber("4007000000027");
    creditCard.setExpirationDate("2027-12");

    const payment = new APIContracts.PaymentType();
    payment.setCreditCard(creditCard);

    const billTo = new APIContracts.NameAndAddressType();
    billTo.setFirstName("John");
    billTo.setLastName("Doe");

    const arbSubscription = new APIContracts.ARBSubscriptionType();
    arbSubscription.setName(data.planName);
    arbSubscription.setPaymentSchedule(paymentSchedule);
    arbSubscription.setAmount(data.planPrice);
    arbSubscription.setPayment(payment);
    arbSubscription.setBillTo(billTo);

    const createRequest = new APIContracts.ARBCreateSubscriptionRequest();
    createRequest.setMerchantAuthentication(merchantAuthenticationType);
    createRequest.setSubscription(arbSubscription);

    const ctrl = new APIControllers.ARBCreateSubscriptionController(createRequest.getJSON());
    ctrl.setEnvironment(Constants.endpoint.sandbox);

    return new Promise((resolve, reject) => {
        ctrl.execute(async function () { // Added async here
            const apiResponse = ctrl.getResponse();
            const response = new APIContracts.ARBCreateSubscriptionResponse(apiResponse);

            if (response != null) {
                if (response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
                    const subscriptionId = response.getSubscriptionId();
                    functions.logger.info(`Successfully created Auth.Net subscription ID: ${subscriptionId}`);

                    try {
                        const userRecord = await admin.auth().createUser({ email: data.email, password: data.password });
                        functions.logger.info("Successfully created new user in Firebase Auth:", userRecord.uid);

                        const userDocRef = admin.firestore().collection("users").doc(userRecord.uid);
                        await userDocRef.set({
                            email: data.email,
                            planName: data.planName,
                            authNetSubscriptionId: subscriptionId,
                            status: "active"
                        });
                        functions.logger.info("Successfully saved user details to Firestore.");
                        
                        resolve({ status: 'success', userId: userRecord.uid });

                    } catch (error) {
                        functions.logger.error("Error creating Firebase user or saving to Firestore:", error);
                        reject(new functions.https.HttpsError('internal', 'Payment succeeded, but failed to create user account.'));
                    }
                } else {
                    const message = response.getMessages().getMessage()[0];
                    const errorCode = message.getCode();
                    const errorText = message.getText();
                    functions.logger.error(`Authorize.Net rejected transaction: ${errorCode} - ${errorText}`);
                    reject(new functions.https.HttpsError('aborted', `Payment failed: ${errorText}`));
                }
            } else {
                reject(new functions.https.HttpsError('internal', 'Received a null response from Authorize.Net.'));
            }
        });
    });
});