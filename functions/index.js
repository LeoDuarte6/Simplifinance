const functions = require("firebase-functions");
const admin = require("firebase-admin");
const authorizenet = require("authorizenet");

require("dotenv").config();
admin.initializeApp();

// --- Authorize.Net API Setup ---
const apiLoginId = process.env.AUTHORIZENET_API_LOGIN_ID;
const transactionKey = process.env.AUTHORIZENET_TRANSACTION_KEY;

// Correctly create the merchantAuthenticationType object
const merchantAuthenticationType = new authorizenet.APIContracts.MerchantAuthenticationType();
merchantAuthenticationType.setName(apiLoginId);
merchantAuthenticationType.setTransactionKey(transactionKey);

// This is the controller for creating a recurring billing subscription
// We access it directly from the main 'authorizenet' object
const ctrl = new authorizenet.ARBSubscriptionController(merchantAuthenticationType);

// Set the environment to the SANDBOX for testing
ctrl.setEnvironment(authorizenet.Constants.endpoint.sandbox);


// --- Main Cloud Function ---
exports.createSubscription = functions.https.onCall(async (data, context) => {
    functions.logger.info(`Starting subscription request for: ${data.email}`);

    if (!apiLoginId || !transactionKey) {
        functions.logger.error("Authorize.Net credentials are not configured.");
        throw new functions.https.HttpsError('internal', 'The server is not configured for payments.');
    }

    // 1. Define the Subscription Details
    const subscription = new authorizenet.APIContracts.ARBSubscriptionType();
    subscription.setName(data.planName);

    const interval = new authorizenet.APIContracts.PaymentScheduleType.Interval();
    interval.setLength(1);
    interval.setUnit(authorizenet.APIContracts.ARBSubscriptionUnitEnum.MONTHS);

    const paymentSchedule = new authorizenet.APIContracts.PaymentScheduleType();
    paymentSchedule.setStartDate(new Date().toISOString().substring(0, 10));
    paymentSchedule.setTotalOccurrences(9999);
    paymentSchedule.setInterval(interval);

    const price = data.planPrice.replace('$', '');
    subscription.setPaymentSchedule(paymentSchedule);
    subscription.setAmount(price);

    // 2. Define the Customer's Payment Information
    const creditCard = new authorizenet.APIContracts.CreditCardType();
    creditCard.setCardNumber("4007000000027"); // Official Authorize.Net test card
    creditCard.setExpirationDate("2027-12"); // Any future date

    const payment = new authorizenet.APIContracts.PaymentType();
    payment.setCreditCard(creditCard);
    subscription.setPayment(payment);

    // 3. Define Customer Info
    const billTo = new authorizenet.APIContracts.NameAndAddressType();
    billTo.setFirstName("John");
    billTo.setLastName("Doe");
    subscription.setBillTo(billTo);

    // 4. Build the final API request
    const createRequest = new authorizenet.APIContracts.ARBCreateSubscriptionRequest();
    createRequest.setSubscription(subscription);

    // 5. Execute the request and handle the response
    return new Promise((resolve, reject) => {
        ctrl.execute(createRequest, function (err, response) {
            if (err) {
                functions.logger.error("Authorize.Net Execute Error:", err);
                return reject(new functions.https.HttpsError('internal', 'Error processing subscription.'));
            }

            const apiResponse = response.getMessages();
            if (apiResponse.getResultCode() === authorizenet.APIContracts.MessageTypeEnum.OK) {
                const subscriptionId = response.getSubscriptionId();
                functions.logger.info(`Successfully created subscription with ID: ${subscriptionId}`);
                
                // TODO: Create Firebase user and save details to Firestore
                
                resolve({ status: 'success', subscriptionId: subscriptionId });
            } else {
                const errorCode = apiResponse.getMessage()[0].getCode();
                const errorText = apiResponse.getMessage()[0].getText();
                functions.logger.error(`Authorize.Net rejected transaction: ${errorCode} - ${errorText}`);
                reject(new functions.https.HttpsError('aborted', `Payment failed: ${errorText}`));
            }
        });
    });
});