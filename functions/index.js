const functions = require("firebase-functions");
const admin = require("firebase-admin");
const authorizenet = require("authorizenet");

require("dotenv").config();
admin.initializeApp();

// Correctly reference the necessary classes from the library
const { APIContracts, Constants } = authorizenet;
// The ARBSubscriptionController is on the root object, not inside APIContracts
const { ARBCreateSubscriptionController } = authorizenet;

// --- Authorize.Net API Setup ---
const apiLoginId = process.env.AUTHORIZENET_API_LOGIN_ID;
const transactionKey = process.env.AUTHORIZENET_TRANSACTION_KEY;

const merchantAuthenticationType = new APIContracts.MerchantAuthenticationType();
merchantAuthenticationType.setName(apiLoginId);
merchantAuthenticationType.setTransactionKey(transactionKey);


// --- Main Cloud Function ---
exports.createSubscription = functions.https.onCall(async (data, context) => {
    functions.logger.info(`Starting subscription request for: ${data.email}`);

    if (!apiLoginId || !transactionKey) {
        functions.logger.error("Authorize.Net credentials are not configured.");
        throw new functions.https.HttpsError('internal', 'The server is not configured for payments.');
    }

    // 1. Define the Subscription Details
    const subscription = new APIContracts.ARBSubscriptionType();
    subscription.setName(data.planName);

    const interval = new APIContracts.PaymentScheduleType.Interval();
    interval.setLength(1);
    interval.setUnit(APIContracts.ARBSubscriptionUnitEnum.MONTHS);

    const paymentSchedule = new APIContracts.PaymentScheduleType();
    paymentSchedule.setStartDate(new Date().toISOString().substring(0, 10)); // YYYY-MM-DD format
    paymentSchedule.setTotalOccurrences(9999); // Indefinite subscription
    paymentSchedule.setInterval(interval);

    const price = data.planPrice.toString().replace('$', '');
    subscription.setAmount(price);
    subscription.setPaymentSchedule(paymentSchedule);

    // 2. Define the Customer's Payment Information
    const creditCard = new APIContracts.CreditCardType();
    creditCard.setCardNumber("4007000000027"); // Official Authorize.Net test card
    creditCard.setExpirationDate("2027-12");   // YYYY-MM format

    const payment = new APIContracts.PaymentType();
    payment.setCreditCard(creditCard);
    subscription.setPayment(payment);

    // 3. Define Customer Info
    const billTo = new APIContracts.NameAndAddressType();
    billTo.setFirstName("John");
    billTo.setLastName("Doe");
    subscription.setBillTo(billTo);

    // 4. Build the final API request object
    const createRequest = new APIContracts.ARBCreateSubscriptionRequest();
    createRequest.setSubscription(subscription);
    createRequest.setMerchantAuthentication(merchantAuthenticationType);

    // THIS IS THE CORRECTED PART: Create the controller and execute the request
    const ctrl = new ARBCreateSubscriptionController(createRequest.getJSON());

    // 5. Execute the request and handle the response
    return new Promise((resolve, reject) => {
        // We pass the callback to the execute method
        ctrl.execute(function () {
            const apiResponse = ctrl.getResponse();
            const response = new APIContracts.ARBCreateSubscriptionResponse(apiResponse);

            // Handle controller-level errors
            if (response.getMessages().getResultCode() !== APIContracts.MessageTypeEnum.OK) {
                const message = response.getMessages().getMessage()[0];
                const errorCode = message.getCode();
                const errorText = message.getText();
                functions.logger.error(`Authorize.Net rejected transaction: ${errorCode} - ${errorText}`);
                return reject(new functions.https.HttpsError('aborted', `Payment failed: ${errorText}`));
            }
            
            const subscriptionId = response.getSubscriptionId();
            functions.logger.info(`Successfully created subscription with ID: ${subscriptionId}`);
            
            // TODO: Create Firebase user and save details to Firestore
            
            resolve({ status: 'success', subscriptionId: subscriptionId });
        });
    });
});