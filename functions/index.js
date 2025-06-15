const functions = require("firebase-functions");
const admin = require("firebase-admin");
const authorizenet = require("authorizenet");

require("dotenv").config();
admin.initializeApp();

// --- Authorize.Net API Setup ---
const apiLoginId = process.env.AUTHORIZENET_API_LOGIN_ID;
const transactionKey = process.env.AUTHORIZENET_TRANSACTION_KEY;

const merchantAuthenticationType = new authorizenet.MerchantAuthenticationType();
merchantAuthenticationType.setName(apiLoginId);
merchantAuthenticationType.setTransactionKey(transactionKey);

// This is the controller for a recurring billing subscription
const ctrl = new authorizenet.ARBSubscriptionController(merchantAuthenticationType);

// We set the environment to the SANDBOX for testing
ctrl.setEnvironment(authorizenet.Constants.endpoint.sandbox);


// --- Main Cloud Function ---
exports.createSubscription = functions.https.onCall(async (data, context) => {
    functions.logger.info(`Starting subscription request for: ${data.email}`);

    if (!apiLoginId || !transactionKey) {
        functions.logger.error("Authorize.Net credentials are not configured.");
        throw new functions.https.HttpsError('internal', 'The server is not configured for payments.');
    }

    // 1. Define the Subscription Details
    const subscription = new authorizenet.ARBSubscriptionType();
    subscription.setName(data.planName); // e.g., "Premium Plan"

    const interval = new authorizenet.PaymentScheduleType.Interval();
    interval.setLength(1); // The interval is 1
    interval.setUnit(authorizenet.APIContracts.ARBSubscriptionUnitEnum.MONTHS); // every 1 "month"

    const paymentSchedule = new authorizenet.PaymentScheduleType();
    paymentSchedule.setStartDate(new Date().toISOString().substring(0, 10)); // Starts today
    paymentSchedule.setTotalOccurrences(9999); // Runs indefinitely
    paymentSchedule.setInterval(interval);

    subscription.setPaymentSchedule(paymentSchedule);
    subscription.setAmount(data.planPrice); // e.g., "199.00"

    // 2. Define the Customer's Payment Information (using a test card)
    const creditCard = new authorizenet.CreditCardType();
    creditCard.setCardNumber("4007000000027"); // This is a valid Authorize.Net test card
    creditCard.setExpirationDate("2027-12"); // Any future date

    const payment = new authorizenet.PaymentType();
    payment.setCreditCard(creditCard);
    subscription.setPayment(payment);

    // 3. Define Customer Info (using test data)
    const billTo = new authorizenet.NameAndAddressType();
    billTo.setFirstName("John");
    billTo.setLastName("Doe");
    subscription.setBillTo(billTo);

    // 4. Build the final API request
    const createRequest = new authorizenet.ARBCreateSubscriptionRequest();
    createRequest.setSubscription(subscription);

    // 5. Execute the request
    return new Promise((resolve, reject) => {
        ctrl.execute(createRequest, (err, response) => {
            if (err) {
                functions.logger.error("Authorize.Net Error:", err);
                reject(new functions.https.HttpsError('internal', 'Error creating subscription.'));
            }

            if (response.getMessages().getResultCode() === authorizenet.APIContracts.MessageTypeEnum.OK) {
                const subscriptionId = response.getSubscriptionId();
                functions.logger.info(`Successfully created subscription with ID: ${subscriptionId}`);
                
                // --- TODO: Create user in Firebase Auth and save details to Firestore ---

                resolve({ status: 'success', subscriptionId: subscriptionId });
            } else {
                const errorCode = response.getMessages().getMessage()[0].getCode();
                const errorText = response.getMessages().getMessage()[0].getText();
                functions.logger.error(`Authorize.Net rejected transaction: ${errorCode} - ${errorText}`);
                reject(new functions.https.HttpsError('aborted', `Payment failed: ${errorText}`));
            }
        });
    });
});