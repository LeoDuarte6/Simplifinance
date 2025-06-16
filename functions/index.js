const functions = require("firebase-functions");
const admin = require("firebase-admin");

// Correctly require the library
const authorizenet = require("authorizenet");

// Load secret keys from your .env file
require("dotenv").config();
admin.initializeApp();

// Destructure the main components from the library object
const { APIContracts, Constants, Controllers } = authorizenet;

// --- Main Cloud Function ---
exports.createSubscription = functions.https.onCall(async (data, context) => {
    functions.logger.info(`Starting subscription request for: ${data.email}`);

    const apiLoginId = process.env.AUTHORIZENET_API_LOGIN_ID;
    const transactionKey = process.env.AUTHORIZENET_TRANSACTION_KEY;

    if (!apiLoginId || !transactionKey) {
        functions.logger.error("Authorize.Net credentials are not configured.");
        throw new functions.https.HttpsError('internal', 'The server is not configured for payments.');
    }

    const merchantAuthenticationType = new APIContracts.MerchantAuthenticationType();
    merchantAuthenticationType.setName(apiLoginId);
    merchantAuthenticationType.setTransactionKey(transactionKey);

    // --- Build the Subscription Request ---

    const interval = new APIContracts.PaymentScheduleType.Interval();
    interval.setLength(1);
    interval.setUnit(APIContracts.ARBSubscriptionUnitEnum.MONTHS);

    const paymentSchedule = new APIContracts.PaymentScheduleType();
    paymentSchedule.setStartDate(new Date().toISOString().substring(0, 10));
    paymentSchedule.setTotalOccurrences(9999);
    paymentSchedule.setInterval(interval);

    const creditCard = new APIContracts.CreditCardType();
    creditCard.setCardNumber("4007000000027"); // Official Authorize.Net test card
    creditCard.setExpirationDate("2027-12");   // YYYY-MM format

    const payment = new APIContracts.PaymentType();
    payment.setCreditCard(creditCard);
    
    const billTo = new APIContracts.NameAndAddressType();
    billTo.setFirstName("John");
    billTo.setLastName("Doe");
    
    const subscription = new APIContracts.ARBSubscriptionType();
    subscription.setName(data.planName);
    subscription.setPaymentSchedule(paymentSchedule);
    subscription.setAmount(data.planPrice.toString().replace('$', ''));
    subscription.setPayment(payment);
    subscription.setBillTo(billTo);

    const createRequest = new APIContracts.ARBCreateSubscriptionRequest();
    createRequest.setMerchantAuthentication(merchantAuthenticationType);
    createRequest.setSubscription(subscription);

    // --- Execute the Request ---
    
    // Use the correct Controller class from the destructuring
    const ctrl = new Controllers.ARBCreateSubscriptionController(createRequest.getJSON());
    
    // Set the environment to the SANDBOX for testing
    ctrl.setEnvironment(Constants.endpoint.sandbox);

    return new Promise((resolve, reject) => {
        ctrl.execute(function () {
            const apiResponse = ctrl.getResponse();
            const response = new APIContracts.ARBCreateSubscriptionResponse(apiResponse);

            if (response != null && response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
                const subscriptionId = response.getSubscriptionId();
                functions.logger.info(`Successfully created subscription with ID: ${subscriptionId}`);
                
                // TODO: Create Firebase user and save details to Firestore
                
                resolve({ status: 'success', subscriptionId: subscriptionId });
            } else {
                const message = response.getMessages().getMessage()[0];
                const errorCode = message.getCode();
                const errorText = message.getText();
                functions.logger.error(`Authorize.Net Error: ${errorCode} - ${errorText}`);
                reject(new functions.https.HttpsError('aborted', `Payment failed: ${errorText}`));
            }
        });
    });
});